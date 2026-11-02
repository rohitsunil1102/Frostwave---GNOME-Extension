// SPDX-License-Identifier: GPL-2.0-or-later

// Client for the MPRIS D-Bus interface that media players (Spotify, YouTube
// Music, Deezer, browsers, VLC, ...) use to publish their state and accept
// remote control commands.
// https://specifications.freedesktop.org/mpris-spec/latest/

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {serviceForBusName, serviceForDesktopEntry, serviceForIdentity, serviceForUrl} from './musicServices.js';

const BUS_NAME_PREFIX = 'org.mpris.MediaPlayer2.';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const ROOT_IFACE = 'org.mpris.MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const CALL_TIMEOUT_MS = 5000;

const MPRIS_XML = `<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="PlayPause"/>
    <method name="Seek">
      <arg direction="in" name="Offset" type="x"/>
    </method>
    <method name="SetPosition">
      <arg direction="in" name="TrackId" type="o"/>
      <arg direction="in" name="Position" type="x"/>
    </method>
    <signal name="Seeked">
      <arg name="Position" type="x"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Rate" type="d" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

/**
 * @param {Error} error
 * @returns {boolean}
 */
export function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function stringValue(value) {
    return typeof value === 'string' ? value : '';
}

function callProxy(proxy, method, params, cancellable) {
    return new Promise((resolve, reject) => {
        proxy.call(method, params, Gio.DBusCallFlags.NO_AUTO_START,
            CALL_TIMEOUT_MS, cancellable, (source, result) => {
                try {
                    resolve(source.call_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/**
 * A single media player on the session bus.
 */
export const MprisPlayer = GObject.registerClass({
    Signals: {
        'changed': {},
        'position-changed': {},
    },
}, class MprisPlayer extends GObject.Object {
    /**
     * @param {string} busName - the player's well-known bus name
     * @param {Gio.DBusNodeInfo} nodeInfo - parsed MPRIS introspection data
     */
    constructor(busName, nodeInfo) {
        super();

        this.busName = busName;
        // Matched by bus name first; the track URL catches services running
        // in a browser or under a generic bus name.
        this._busService = serviceForBusName(busName);
        // Monotonic time (µs) at which the player was last seen playing
        this.lastPlayed = 0;

        this._nodeInfo = nodeInfo;
        this._cancellable = new Gio.Cancellable();
        this._rootProxy = null;
        this._playerProxy = null;
        this._handlerIds = [];

        this._metadata = {};
        this._trackKey = null;
        this._status = 'Stopped';
        // Last known position (µs) and the monotonic time it was sampled at
        this._position = 0;
        this._positionTime = 0;
    }

    async init() {
        [this._rootProxy, this._playerProxy] = await Promise.all([
            this._createProxy(ROOT_IFACE),
            this._createProxy(PLAYER_IFACE),
        ]);

        this._handlerIds.push(
            [this._rootProxy, this._rootProxy.connect('g-properties-changed',
                () => this.emit('changed'))],
            [this._playerProxy, this._playerProxy.connect('g-properties-changed',
                (_proxy, changed) => this._onPlayerPropertiesChanged(changed))],
            [this._playerProxy, this._playerProxy.connect('g-signal',
                (_proxy, _sender, signal, params) => {
                    if (signal === 'Seeked')
                        this._setPosition(params.get_child_value(0).unpack());
                })]);

        // Both also fetch the current position
        this._readMetadata();
        this._readStatus();
    }

    destroy() {
        this._cancellable.cancel();
        for (const [proxy, id] of this._handlerIds)
            proxy.disconnect(id);
        this._handlerIds = [];
        this._rootProxy = null;
        this._playerProxy = null;
    }

    _createProxy(iface) {
        return new Promise((resolve, reject) => {
            Gio.DBusProxy.new_for_bus(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START |
                    Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
                this._nodeInfo.lookup_interface(iface),
                this.busName, OBJECT_PATH, iface,
                this._cancellable,
                (_source, result) => {
                    try {
                        resolve(Gio.DBusProxy.new_for_bus_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _onPlayerPropertiesChanged(changed) {
        const names = Object.keys(changed.deepUnpack());

        if (names.includes('Metadata'))
            this._readMetadata();
        if (names.includes('PlaybackStatus'))
            this._readStatus();

        this.emit('changed');
    }

    _readMetadata() {
        const metadata =
            this._playerProxy.get_cached_property('Metadata')?.recursiveUnpack() ?? {};
        this._metadata = metadata;

        const trackKey = stringValue(metadata['mpris:trackid']) ||
            `${stringValue(metadata['xesam:title'])}\n${stringValue(metadata['xesam:url'])}`;
        if (trackKey !== this._trackKey) {
            this._trackKey = trackKey;
            this._setPosition(0);
            this.refreshPosition();
        }
    }

    _readStatus() {
        const status = this._playerProperty('PlaybackStatus') ?? 'Stopped';
        if (status === this._status)
            return;

        // Freeze the extrapolated position before the status changes
        this._setPosition(this.position);
        this._status = status;

        if (status === 'Playing')
            this.lastPlayed = GLib.get_monotonic_time();
        this.refreshPosition();
    }

    _setPosition(position) {
        this._position = Math.max(0, position);
        this._positionTime = GLib.get_monotonic_time();
        this.emit('position-changed');
    }

    _rootProperty(name) {
        return this._rootProxy?.get_cached_property(name)?.unpack() ?? null;
    }

    _playerProperty(name) {
        return this._playerProxy?.get_cached_property(name)?.unpack() ?? null;
    }

    get ready() {
        return this._playerProxy !== null;
    }

    get identity() {
        return this._rootProperty('Identity') ||
            this.busName.slice(BUS_NAME_PREFIX.length).split('.')[0];
    }

    get desktopEntry() {
        return this._rootProperty('DesktopEntry') ?? '';
    }

    get canRaise() {
        return this._rootProperty('CanRaise') ?? false;
    }

    /** @type {object|null} the recognised music service, if any */
    get service() {
        return this._busService ??
            serviceForUrl(this.url) ??
            serviceForDesktopEntry(this.desktopEntry) ??
            serviceForIdentity(this.identity);
    }

    get isMusicService() {
        return this.service !== null;
    }

    /** @type {'Playing'|'Paused'|'Stopped'} */
    get status() {
        return this._status;
    }

    get playing() {
        return this._status === 'Playing';
    }

    get canControl() {
        return this._playerProperty('CanControl') ?? true;
    }

    get canGoNext() {
        return this.canControl && !!this._playerProperty('CanGoNext');
    }

    get canGoPrevious() {
        return this.canControl && !!this._playerProperty('CanGoPrevious');
    }

    get canSeek() {
        return this.canControl && !!this._playerProperty('CanSeek') && this.length > 0;
    }

    /** @type {boolean|null} null if the player doesn't support shuffling */
    get shuffle() {
        return this._playerProperty('Shuffle');
    }

    /** @type {'None'|'Track'|'Playlist'|null} null if the player doesn't support it */
    get loopStatus() {
        return this._playerProperty('LoopStatus');
    }

    /** @type {number|null} volume between 0 and 1, null if not supported */
    get volume() {
        return this._playerProperty('Volume');
    }

    get title() {
        return stringValue(this._metadata['xesam:title']);
    }

    /** @type {string[]} */
    get artists() {
        const artists = this._metadata['xesam:artist'];
        if (Array.isArray(artists))
            return artists.filter(a => typeof a === 'string' && a.length > 0);
        return stringValue(artists) ? [artists] : [];
    }

    get album() {
        return stringValue(this._metadata['xesam:album']);
    }

    get artUrl() {
        return stringValue(this._metadata['mpris:artUrl']);
    }

    /** @type {string} web link of the track, if the player provides one */
    get url() {
        return stringValue(this._metadata['xesam:url']);
    }

    get trackId() {
        return stringValue(this._metadata['mpris:trackid']);
    }

    /** @type {number} track length in µs, 0 if unknown */
    get length() {
        const length = Number(this._metadata['mpris:length'] ?? 0);
        return Number.isFinite(length) && length > 0 ? length : 0;
    }

    /** @type {number} current position in µs, extrapolated while playing */
    get position() {
        let position = this._position;
        if (this.playing) {
            const rate = this._playerProperty('Rate') ?? 1;
            position += (GLib.get_monotonic_time() - this._positionTime) * rate;
        }
        return this.length > 0 ? Math.min(position, this.length) : position;
    }

    playPause() {
        this._call(this._playerProxy, 'PlayPause');
    }

    next() {
        this._call(this._playerProxy, 'Next');
    }

    previous() {
        this._call(this._playerProxy, 'Previous');
    }

    raise() {
        this._call(this._rootProxy, 'Raise');
    }

    /**
     * @param {number} position - new position in µs
     */
    seekTo(position) {
        if (!this.canSeek)
            return;

        position = Math.round(Math.min(Math.max(position, 0), this.length));
        if (GLib.Variant.is_object_path(this.trackId)) {
            this._call(this._playerProxy, 'SetPosition',
                new GLib.Variant('(ox)', [this.trackId, position]));
        } else {
            this._call(this._playerProxy, 'Seek',
                new GLib.Variant('(x)', [Math.round(position - this.position)]));
        }
        this._setPosition(position);
    }

    setShuffle(shuffle) {
        this._setPlayerProperty('Shuffle', new GLib.Variant('b', shuffle));
    }

    setLoopStatus(loopStatus) {
        this._setPlayerProperty('LoopStatus', new GLib.Variant('s', loopStatus));
    }

    setVolume(volume) {
        volume = Math.min(Math.max(volume, 0), 1);
        this._setPlayerProperty('Volume', new GLib.Variant('d', volume));
    }

    async refreshPosition() {
        if (!this._playerProxy)
            return;

        try {
            const reply = await callProxy(this._playerProxy,
                'org.freedesktop.DBus.Properties.Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
                this._cancellable);
            const [position] = reply.recursiveUnpack();
            if (Number.isFinite(position))
                this._setPosition(position);
        } catch {
            // Not every player implements Position; keep extrapolating.
        }
    }

    async _call(proxy, method, params = null) {
        if (!proxy)
            return;

        try {
            await callProxy(proxy, method, params, this._cancellable);
        } catch (e) {
            if (!isCancelled(e))
                console.warn(`Frostwave: ${this.identity} ${method} failed: ${e.message}`);
        }
    }

    async _setPlayerProperty(name, value) {
        const proxy = this._playerProxy;
        if (!proxy)
            return;

        try {
            await callProxy(proxy, 'org.freedesktop.DBus.Properties.Set',
                new GLib.Variant('(ssv)', [PLAYER_IFACE, name, value]),
                this._cancellable);

            // Not all players announce the change, so read the value back
            const reply = await callProxy(proxy,
                'org.freedesktop.DBus.Properties.Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE, name]),
                this._cancellable);
            proxy.set_cached_property(name, reply.get_child_value(0).get_variant());
            this.emit('changed');
        } catch (e) {
            if (!isCancelled(e))
                console.warn(`Frostwave: ${this.identity} could not set ${name}: ${e.message}`);
        }
    }
});

/**
 * Tracks all MPRIS players on the session bus and picks the one to show.
 */
export const PlayerManager = GObject.registerClass({
    Signals: {
        // The active player changed, or its state did
        'changed': {},
        'position-changed': {},
    },
}, class PlayerManager extends GObject.Object {
    constructor() {
        super();

        this._nodeInfo = Gio.DBusNodeInfo.new_for_xml(MPRIS_XML);
        this._cancellable = new Gio.Cancellable();
        this._players = new Map();
        this._activePlayer = null;
        this._includeOtherPlayers = false;
        this._subscriptionId = 0;
    }

    /** @type {MprisPlayer|null} */
    get activePlayer() {
        return this._activePlayer;
    }

    get includeOtherPlayers() {
        return this._includeOtherPlayers;
    }

    set includeOtherPlayers(include) {
        if (this._includeOtherPlayers === include)
            return;

        this._includeOtherPlayers = include;
        this._updateActivePlayer();
    }

    start() {
        const bus = Gio.DBus.session;

        this._subscriptionId = bus.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', ROOT_IFACE,
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_connection, _sender, _path, _iface, _signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(BUS_NAME_PREFIX))
                    return;
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });

        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null,
            new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1,
            this._cancellable, (connection, result) => {
                try {
                    const [names] = connection.call_finish(result).deepUnpack();
                    names.filter(n => n.startsWith(BUS_NAME_PREFIX))
                        .forEach(n => this._addPlayer(n));
                } catch (e) {
                    if (!isCancelled(e))
                        console.warn(`Frostwave: could not list media players: ${e.message}`);
                }
            });
    }

    destroy() {
        this._cancellable.cancel();
        if (this._subscriptionId) {
            Gio.DBus.session.signal_unsubscribe(this._subscriptionId);
            this._subscriptionId = 0;
        }
        for (const name of [...this._players.keys()])
            this._removePlayer(name);
        this._activePlayer = null;
    }

    async _addPlayer(busName) {
        if (this._players.has(busName))
            return;

        const player = new MprisPlayer(busName, this._nodeInfo);
        const entry = {player, handlerIds: []};
        this._players.set(busName, entry);

        try {
            await player.init();
        } catch (e) {
            if (!isCancelled(e))
                console.warn(`Frostwave: could not connect to ${busName}: ${e.message}`);
            if (this._players.get(busName) === entry)
                this._removePlayer(busName);
            return;
        }

        // The player may have quit while we were connecting
        if (this._players.get(busName) !== entry)
            return;

        entry.handlerIds = [
            player.connect('changed', () => this._onPlayerChanged(player)),
            player.connect('position-changed', () => {
                if (player === this._activePlayer)
                    this.emit('position-changed');
            }),
        ];
        this._updateActivePlayer();
    }

    _removePlayer(busName) {
        const entry = this._players.get(busName);
        if (!entry)
            return;

        this._players.delete(busName);
        entry.handlerIds.forEach(id => entry.player.disconnect(id));
        entry.player.destroy();

        if (entry.player === this._activePlayer)
            this._updateActivePlayer();
    }

    _onPlayerChanged(player) {
        const switched = this._updateActivePlayer();
        if (!switched && player === this._activePlayer)
            this.emit('changed');
    }

    /**
     * Prefer a playing player, then the current one, then a recognised music
     * service.
     *
     * @returns {boolean} whether the active player changed
     */
    _updateActivePlayer() {
        let best = null;
        let bestScore = -1;

        for (const {player} of this._players.values()) {
            if (!player.ready || (!player.isMusicService && !this._includeOtherPlayers))
                continue;

            const score = (player.playing ? 4 : 0) +
                (player === this._activePlayer ? 2 : 0) +
                (player.isMusicService ? 1 : 0);
            if (score > bestScore ||
                (score === bestScore && player.lastPlayed > best.lastPlayed)) {
                best = player;
                bestScore = score;
            }
        }

        if (best === this._activePlayer)
            return false;

        this._activePlayer = best;
        this.emit('changed');
        return true;
    }
});
