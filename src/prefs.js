// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class FrostwavePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(620, 780);

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        page.add(this._widgetGroup(settings));
        page.add(this._appearanceGroup(settings));
        page.add(this._panelGroup(settings));
        page.add(this._playersGroup(settings));
    }

    _widgetGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Desktop Widget'),
            description: _('Drag the widget to move it. Right-click it for more options.'),
        });

        group.add(this._switchRow(settings, 'show-desktop-widget', _('Show Desktop Widget')));
        group.add(this._comboRow(settings, 'widget-layer', _('Layer'), [
            ['desktop', _('Below windows')],
            ['above', _('Above windows')],
        ]));
        group.add(this._scaleRow(settings, 'widget-scale', _('Size'), 70, 160, 5, '%'));
        group.add(this._switchRow(settings, 'lock-position', _('Lock Position')));

        const resetRow = new Adw.ActionRow({title: _('Position')});
        const resetButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
        });
        resetButton.connect('clicked', () => {
            settings.reset('widget-x');
            settings.reset('widget-y');
        });
        resetRow.add_suffix(resetButton);
        group.add(resetRow);

        return group;
    }

    _appearanceGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Appearance')});

        group.add(this._comboRow(settings, 'background-style', _('Background'), [
            ['glass', _('Frosted glass')],
            ['artwork', _('Album art')],
        ]));
        group.add(this._comboRow(settings, 'tint', _('Tint'), [
            ['dark', _('Dark')],
            ['light', _('Light')],
            ['adaptive', _('Album color')],
        ]));
        group.add(this._scaleRow(settings, 'background-opacity', _('Opacity'), 0, 100, 5, '%',
            _('Lower values make the glass more transparent')));
        group.add(this._scaleRow(settings, 'blur-radius', _('Blur'), 0, 60, 1, ' px',
            _('0 turns the frosted effect off')));
        group.add(this._scaleRow(settings, 'corner-radius', _('Corner Radius'), 0, 40, 1, ' px'));
        group.add(this._switchRow(settings, 'show-progress', _('Show Seek Bar')));
        group.add(this._switchRow(settings, 'show-volume', _('Show Volume')));

        return group;
    }

    _panelGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Top Bar')});

        group.add(this._switchRow(settings, 'show-panel-button', _('Show in Top Bar')));
        group.add(this._comboRow(settings, 'panel-position', _('Position'), [
            ['left', _('Left')],
            ['center', _('Center')],
            ['right', _('Right')],
        ]));
        group.add(this._switchRow(settings, 'panel-show-title', _('Show Song Title')));

        return group;
    }

    _playersGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Players')});

        group.add(this._switchRow(settings, 'other-players', _('Other Media Players'),
            _('Also show browsers, video players and other apps')));
        group.add(this._switchRow(settings, 'hide-when-inactive', _('Hide When No Player Is Running')));

        return group;
    }

    _switchRow(settings, key, title, subtitle = null) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    /**
     * @param {Gio.Settings} settings
     * @param {string} key - a string key with choices
     * @param {string} title
     * @param {string[][]} options - [value, label] pairs
     * @returns {Adw.ComboRow}
     */
    _comboRow(settings, key, title, options) {
        const row = new Adw.ComboRow({
            title,
            model: Gtk.StringList.new(options.map(([, label]) => label)),
        });

        const sync = () => {
            const index = options.findIndex(([value]) => value === settings.get_string(key));
            row.selected = Math.max(index, 0);
        };
        sync();

        const changedId = settings.connect(`changed::${key}`, sync);
        row.connect('notify::selected', () => {
            const [value] = options[row.selected];
            if (settings.get_string(key) !== value)
                settings.set_string(key, value);
        });
        row.connect('destroy', () => settings.disconnect(changedId));

        return row;
    }

    _scaleRow(settings, key, title, lower, upper, step, unit, subtitle = null) {
        const row = new Adw.ActionRow({title, subtitle});

        const adjustment = new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step,
            page_increment: step * 5,
        });
        settings.bind(key, adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        const scale = new Gtk.Scale({
            adjustment,
            digits: 0,
            round_digits: 0,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            width_request: 240,
            valign: Gtk.Align.CENTER,
        });
        scale.set_format_value_func((_scale, value) => `${Math.round(value)}${unit}`);
        row.add_suffix(scale);

        return row;
    }
}
