// SPDX-License-Identifier: GPL-2.0-or-later

// The player UI: cover, track info, seek bar, playback controls and volume.
// Used both by the desktop widget and the top bar menu.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {RoundedCornersEffect} from './effects.js';

const SEEK_DELAY_MS = 300;
const VOLUME_DELAY_MS = 80;
const COPIED_FEEDBACK_MS = 1500;

// Secondary text is dimmed with opacity, so it works with any text color
const SOURCE_OPACITY = 140;
const ARTIST_OPACITY = 220;
const ALBUM_OPACITY = 150;
const TIME_OPACITY = 165;
const INSENSITIVE_OPACITY = 90;

const NEXT_LOOP_STATUS = {
    'None': 'Playlist',
    'Playlist': 'Track',
    'Track': 'None',
};

/**
 * @param {number} microseconds
 * @returns {string} m:ss or h:mm:ss
 */
function formatTime(microseconds) {
    const total = Math.max(Math.floor(microseconds / 1e6), 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    const seconds = String(total % 60).padStart(2, '0');

    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
        : `${minutes}:${seconds}`;
}

function volumeIconName(volume) {
    if (volume <= 0)
        return 'audio-volume-muted-symbolic';
    if (volume < 1 / 3)
        return 'audio-volume-low-symbolic';
    if (volume < 2 / 3)
        return 'audio-volume-medium-symbolic';
    return 'audio-volume-high-symbolic';
}

export const PlayerView = GObject.registerClass(
class PlayerView extends St.BoxLayout {
    /**
     * @param {import('./nowPlaying.js').NowPlaying} nowPlaying
     * @param {Gio.Settings} settings
     */
    constructor(nowPlaying, settings) {
        super({
            style_class: 'frostwave-view',
            orientation: Clutter.Orientation.VERTICAL,
        });

        this._nowPlaying = nowPlaying;
        this._settings = settings;
        this._player = null;
        this._holdingPosition = false;
        this._seeking = false;
        this._updating = false;
        this._volumeDragging = false;
        this._volumeBeforeMute = 0.5;
        this._seekTimeoutId = 0;
        this._volumeTimeoutId = 0;
        this._copiedTimeoutId = 0;

        this._buildHeader();
        this._buildProgress();
        this._buildControls();
        this._buildVolume();

        this._launchButton = new St.Button({
            style_class: 'frostwave-launch-button',
            label: _('Open Music Player'),
            x_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
        });
        this._launchButton.connect('clicked', () => this._nowPlaying.showPlayer());
        this.add_child(this._launchButton);

        nowPlaying.connectObject(
            'changed', () => this._sync(),
            'artwork-changed', () => this._syncArtwork(),
            'position-changed', () => this._syncPosition(),
            this);
        settings.connectObject(
            'changed::show-progress', () => this._sync(),
            'changed::show-volume', () => this._sync(),
            this);

        this.connect('notify::mapped', () => this._syncPositionHold());
        this.connect('destroy', () => this._onDestroy());

        this._sync();
        this._syncArtwork();
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'frostwave-header'});
        this.add_child(header);

        // x_expand is set explicitly, so it isn't inherited from the cover's
        // children and the cover stays square
        const coverButton = new St.Button({
            style_class: 'frostwave-cover-button',
            accessible_name: _('Show player'),
            x_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
        });
        coverButton.connect('clicked', () => this._nowPlaying.showPlayer());
        header.add_child(coverButton);

        this._cover = new St.Widget({
            style_class: 'frostwave-cover',
            layout_manager: new Clutter.BinLayout(),
        });
        coverButton.set_child(this._cover);

        this._coverPlaceholder = new St.Icon({
            style_class: 'frostwave-cover-placeholder',
            icon_name: 'audio-x-generic-symbolic',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._cover.add_child(this._coverPlaceholder);

        this._coverImage = new St.Widget({x_expand: true, y_expand: true});
        this._coverImage.set_content_scaling_filters(
            Clutter.ScalingFilter.TRILINEAR, Clutter.ScalingFilter.LINEAR);
        this._coverCorners = new RoundedCornersEffect();
        this._coverImage.add_effect(this._coverCorners);
        this._cover.add_child(this._coverImage);

        this._cover.connect('style-changed', () => {
            const node = this._cover.get_theme_node();
            this._coverCorners.radius = node.get_border_radius(St.Corner.TOPLEFT);
        });

        const info = new St.BoxLayout({
            style_class: 'frostwave-info',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(info);

        const sourceRow = new St.BoxLayout({style_class: 'frostwave-source-row'});
        info.add_child(sourceRow);

        this._sourceLabel = this._createLabel('frostwave-source', SOURCE_OPACITY);
        this._sourceLabel.y_align = Clutter.ActorAlign.CENTER;
        sourceRow.add_child(this._sourceLabel);

        this._copyButton = this._createButton('edit-copy-symbolic',
            _('Copy song link'), () => this._copyLink());
        this._copyButton.add_style_class_name('frostwave-small-button');
        sourceRow.add_child(this._copyButton);

        this._titleLabel = this._createLabel('frostwave-title');
        this._artistLabel = this._createLabel('frostwave-artist', ARTIST_OPACITY);
        this._albumLabel = this._createLabel('frostwave-album', ALBUM_OPACITY);
        info.add_child(this._titleLabel);
        info.add_child(this._artistLabel);
        info.add_child(this._albumLabel);
    }

    _buildProgress() {
        this._progress = new St.BoxLayout({
            style_class: 'frostwave-progress',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this.add_child(this._progress);

        this._seekSlider = new Slider(0);
        this._seekSlider.add_style_class_name('frostwave-slider');
        this._seekSlider.accessible_name = _('Position');
        this._seekSlider.connect('drag-begin', () => {
            this._seeking = true;
        });
        this._seekSlider.connect('drag-end', () => {
            this._seeking = false;
            this._seekToSlider();
        });
        this._seekSlider.connect('notify::value', () => {
            if (this._updating)
                return;
            this._elapsedLabel.text =
                formatTime(this._seekSlider.value * (this._player?.length ?? 0));
            // Scrolling and arrow keys change the value without a drag
            if (!this._seeking)
                this._queueSeek();
        });
        this._progress.add_child(this._seekSlider);

        const times = new St.BoxLayout({style_class: 'frostwave-times'});
        this._progress.add_child(times);

        this._elapsedLabel = new St.Label({
            style_class: 'frostwave-time',
            opacity: TIME_OPACITY,
            x_expand: true,
        });
        this._durationLabel = new St.Label({
            style_class: 'frostwave-time',
            opacity: TIME_OPACITY,
        });
        times.add_child(this._elapsedLabel);
        times.add_child(this._durationLabel);
    }

    _buildControls() {
        this._controls = new St.BoxLayout({
            style_class: 'frostwave-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._controls);

        this._shuffleButton = this._createButton('media-playlist-shuffle-symbolic',
            _('Shuffle'), player => player.setShuffle(!player.shuffle));
        this._previousButton = this._createButton('media-skip-backward-symbolic',
            _('Previous'), player => player.previous());
        this._playButton = this._createButton('media-playback-start-symbolic',
            _('Play'), player => player.playPause());
        this._playButton.add_style_class_name('frostwave-play-button');
        this._nextButton = this._createButton('media-skip-forward-symbolic',
            _('Next'), player => player.next());
        this._repeatButton = this._createButton('media-playlist-repeat-symbolic',
            _('Repeat'), player => player.setLoopStatus(NEXT_LOOP_STATUS[player.loopStatus] ?? 'None'));

        for (const button of [this._shuffleButton, this._previousButton,
            this._playButton, this._nextButton, this._repeatButton])
            this._controls.add_child(button);
    }

    _buildVolume() {
        this._volumeBox = new St.BoxLayout({style_class: 'frostwave-volume'});
        this.add_child(this._volumeBox);

        this._muteButton = this._createButton('audio-volume-high-symbolic',
            _('Mute'), () => this._toggleMute());
        this._muteButton.add_style_class_name('frostwave-small-button');
        this._volumeBox.add_child(this._muteButton);

        this._volumeSlider = new Slider(0);
        this._volumeSlider.add_style_class_name('frostwave-slider');
        this._volumeSlider.accessible_name = _('Volume');
        this._volumeSlider.y_align = Clutter.ActorAlign.CENTER;
        this._volumeSlider.connect('drag-begin', () => {
            this._volumeDragging = true;
        });
        this._volumeSlider.connect('drag-end', () => {
            this._volumeDragging = false;
        });
        this._volumeSlider.connect('notify::value', () => {
            if (!this._updating)
                this._queueVolumeChange();
        });
        this._volumeBox.add_child(this._volumeSlider);
    }

    _createLabel(styleClass, opacity = 255) {
        const label = new St.Label({style_class: styleClass, opacity, x_expand: true});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        return label;
    }

    /**
     * @param {string} iconName
     * @param {string} accessibleName
     * @param {Function} callback - called with the active player
     * @returns {St.Button}
     */
    _createButton(iconName, accessibleName, callback) {
        const button = new St.Button({
            style_class: 'frostwave-button',
            icon_name: iconName,
            accessible_name: accessibleName,
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
        });
        button.connect('clicked', () => {
            if (this._player)
                callback(this._player);
        });
        return button;
    }

    _setSensitive(button, sensitive) {
        button.reactive = sensitive;
        button.can_focus = sensitive;
        button.opacity = sensitive ? 255 : INSENSITIVE_OPACITY;
    }

    _sync() {
        const player = this._nowPlaying.player;
        if (player !== this._player)
            this._cancelPendingChanges();
        this._player = player;

        const hasPlayer = player !== null;
        const musicApp = this._nowPlaying.musicApp;
        this._controls.visible = hasPlayer;
        this._launchButton.visible = !hasPlayer && musicApp !== null;
        this._launchButton.label = musicApp
            ? _('Open %s').replace('%s', musicApp.name)
            : '';

        if (!hasPlayer) {
            this._sourceLabel.text = '';
            this._titleLabel.text = _('Nothing playing');
            this._artistLabel.text = musicApp
                ? _('%s isn’t running').replace('%s', musicApp.name)
                : _('No media player found');
            this._albumLabel.text = '';
            this._copyButton.visible = false;
            this._progress.visible = false;
            this._volumeBox.visible = false;
            return;
        }

        this._sourceLabel.text = (player.service?.name ?? player.identity).toUpperCase();
        this._titleLabel.text = player.title ||
            (player.status === 'Stopped' ? _('Nothing playing') : player.identity);
        this._artistLabel.text = player.artists.join(', ');
        this._albumLabel.text = player.album;
        this._copyButton.visible = /^https?:\/\//.test(player.url);

        const playing = player.playing;
        this._playButton.icon_name = playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._playButton.accessible_name = playing ? _('Pause') : _('Play');
        this._setSensitive(this._playButton, player.canControl);
        this._setSensitive(this._previousButton, player.canGoPrevious);
        this._setSensitive(this._nextButton, player.canGoNext);

        const shuffle = player.shuffle;
        this._shuffleButton.visible = shuffle !== null;
        this._shuffleButton.checked = shuffle === true;
        this._setSensitive(this._shuffleButton, player.canControl);

        const loopStatus = player.loopStatus;
        this._repeatButton.visible = loopStatus !== null;
        this._repeatButton.checked = loopStatus === 'Playlist' || loopStatus === 'Track';
        this._repeatButton.icon_name = loopStatus === 'Track'
            ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
        this._setSensitive(this._repeatButton, player.canControl);

        this._progress.visible = this._settings.get_boolean('show-progress') &&
            player.length > 0;
        this._volumeBox.visible = this._settings.get_boolean('show-volume') &&
            player.volume !== null && player.canControl;

        this._syncPosition();
        this._syncVolume();
    }

    _syncArtwork() {
        const content = this._nowPlaying.artworkContent;
        this._coverImage.content = content;
        this._coverImage.visible = content !== null;
        this._coverPlaceholder.visible = content === null;
    }

    _syncPosition() {
        const player = this._player;
        if (!player || !this._progress.visible)
            return;

        const {length, position} = player;
        this._durationLabel.text = formatTime(length);
        this._seekSlider.reactive = player.canSeek;

        // Don't fight the user while they are choosing a new position
        if (this._seeking || this._seekTimeoutId)
            return;

        this._updating = true;
        this._seekSlider.value = length > 0 ? position / length : 0;
        this._updating = false;
        this._elapsedLabel.text = formatTime(position);
    }

    _syncVolume() {
        const volume = this._player?.volume;
        if (volume === null || volume === undefined)
            return;

        this._muteButton.icon_name = volumeIconName(volume);
        this._muteButton.accessible_name = volume > 0 ? _('Mute') : _('Unmute');

        if (this._volumeDragging || this._volumeTimeoutId)
            return;

        this._updating = true;
        this._volumeSlider.value = volume;
        this._updating = false;
    }

    _syncPositionHold() {
        const hold = this.mapped;
        if (hold === this._holdingPosition)
            return;

        this._holdingPosition = hold;
        if (hold) {
            this._nowPlaying.holdPositionUpdates();
            this._player?.refreshPosition();
            this._syncPosition();
        } else {
            this._nowPlaying.releasePositionUpdates();
        }
    }

    _queueSeek() {
        if (this._seekTimeoutId)
            GLib.source_remove(this._seekTimeoutId);

        this._seekTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEEK_DELAY_MS, () => {
            this._seekTimeoutId = 0;
            this._seekToSlider();
            return GLib.SOURCE_REMOVE;
        });
    }

    _seekToSlider() {
        if (this._seekTimeoutId) {
            GLib.source_remove(this._seekTimeoutId);
            this._seekTimeoutId = 0;
        }
        this._player?.seekTo(this._seekSlider.value * this._player.length);
    }

    _queueVolumeChange() {
        if (this._volumeTimeoutId)
            return;

        // Throttle, so dragging doesn't flood the player with D-Bus calls
        this._volumeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VOLUME_DELAY_MS, () => {
            this._volumeTimeoutId = 0;
            this._player?.setVolume(this._volumeSlider.value);
            return GLib.SOURCE_REMOVE;
        });
    }

    _toggleMute() {
        const volume = this._player?.volume;
        if (volume === null || volume === undefined)
            return;

        if (volume > 0) {
            this._volumeBeforeMute = volume;
            this._player.setVolume(0);
        } else {
            this._player.setVolume(this._volumeBeforeMute);
        }
    }

    _copyLink() {
        const url = this._player?.url;
        if (!url)
            return;

        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, url);

        this._copyButton.icon_name = 'object-select-symbolic';
        this._copyButton.accessible_name = _('Link copied');
        if (this._copiedTimeoutId)
            GLib.source_remove(this._copiedTimeoutId);
        this._copiedTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COPIED_FEEDBACK_MS, () => {
            this._copiedTimeoutId = 0;
            this._copyButton.icon_name = 'edit-copy-symbolic';
            this._copyButton.accessible_name = _('Copy song link');
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelPendingChanges() {
        if (this._seekTimeoutId) {
            GLib.source_remove(this._seekTimeoutId);
            this._seekTimeoutId = 0;
        }
        if (this._volumeTimeoutId) {
            GLib.source_remove(this._volumeTimeoutId);
            this._volumeTimeoutId = 0;
        }
    }

    _onDestroy() {
        this._cancelPendingChanges();
        if (this._copiedTimeoutId) {
            GLib.source_remove(this._copiedTimeoutId);
            this._copiedTimeoutId = 0;
        }
        if (this._holdingPosition) {
            this._holdingPosition = false;
            this._nowPlaying.releasePositionUpdates();
        }
    }
});
