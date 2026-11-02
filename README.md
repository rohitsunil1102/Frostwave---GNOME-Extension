# Frostwave

A frosted-glass music widget for the GNOME desktop. It shows what's playing in
Spotify, YouTube Music, Deezer and other music players — cover art, title,
artist and album — with all the playback controls, right on your desktop.

![Frostwave playing a song from Spotify](docs/screenshots/frostwave.png)

## Features

- **Desktop widget** that sits on the wallpaper below your windows (it works
  alongside the Ubuntu desktop icons), or floats above all windows.
- **Frosted glass** — a live blur of whatever is behind the widget, with
  adjustable transparency, blur strength, tint (dark, light or matched to the
  album art) and corner radius. Or use the blurred album art as the background.
- **All the controls**: play/pause, previous/next, shuffle, repeat
  (off / playlist / track), a seek bar and volume with mute.
- **Copy the song link** to share it, or click the cover to bring up the player.
  If the player isn't running, the widget offers to open it.
- **Top bar button** with the current song and the same player in its menu.
- Drag the widget anywhere, lock its position, and scale it from 70 % to 160 %.
- Optionally controls other media players too (browsers, VLC, …).

## Requirements

- GNOME Shell 50 (Ubuntu 26.04 LTS, Fedora 44, …)
- The Spotify, YouTube Music or Deezer desktop app, or any other player that
  supports [MPRIS](https://specifications.freedesktop.org/mpris-spec/latest/)
  once *Other Media Players* is enabled.

## Installation

### From extensions.gnome.org

Install Frostwave from
[extensions.gnome.org](https://extensions.gnome.org/) or with the *Extension
Manager* app.

### From source

```sh
git clone https://github.com/rohitsunil1102/Frostwave---GNOME-Extension.git
cd Frostwave---GNOME-Extension
make install
```

Then log out and back in (GNOME on Wayland only picks up new extensions at
login) and enable it:

```sh
gnome-extensions enable frostwave@rohitsunil1102.github.io
```

## Usage

- **Move** the widget by dragging it. **Right-click** it to lock its position,
  reset it, hide the widget or open the preferences.
- **Preferences**: right-click the widget, use the top bar menu, or run
  `gnome-extensions prefs frostwave@rohitsunil1102.github.io`.

## Good to know

- Music services only expose playback controls to the desktop (through MPRIS),
  so features such as *liking* a song or browsing playlists aren't available.
- Whether volume, shuffle and repeat can be changed depends on the player;
  controls a player doesn't support are hidden.
- In *Below windows* mode the glass blurs the wallpaper. In *Above windows* mode
  it blurs the windows underneath it as they change.
- **Privacy**: the cover art is downloaded from the image address the player
  provides. The clipboard is only written when you press the copy-link button.
  Nothing else leaves your computer.

## Development

```
src/
├── extension.js         enable/disable, creates the widget and top bar button
├── prefs.js             preferences window (libadwaita)
├── stylesheet.css
├── schemas/             GSettings schema
└── lib/
    ├── mpris.js         MPRIS D-Bus client: finds players, reads state, sends commands
    ├── musicServices.js music services shown by default (Spotify, YouTube Music, Deezer)
    ├── artwork.js       downloads and decodes album art, picks an accent color
    ├── nowPlaying.js    shared state for all views (active player, artwork, position)
    ├── playerView.js    the player UI: cover, track info, seek bar, controls, volume
    ├── desktopWidget.js the frosted desktop widget: stacking, dragging, menu
    ├── indicator.js     top bar button
    └── effects.js       GLSL effect that rounds the corners of the blur and cover
tests/
├── run-headless.sh      runs the extension in a throwaway headless GNOME Shell
├── automation.js        clicks through the widget and checks the results
├── screenshots.js       renders screenshots of each background style
└── mock-player.js       a fake Spotify MPRIS player
```

| Command | What it does |
|---|---|
| `make install` | Builds and installs the extension for your user |
| `make pack` | Creates the zip for extensions.gnome.org in `build/` |
| `make test` | Runs the automated test in a headless GNOME Shell with a mock player |
| `make lint` | Runs ESLint |

`make test` starts GNOME Shell on a private D-Bus session with temporary
settings, so it doesn't touch your running desktop. Set `SHELL_MODE=ubuntu` to
also load the Ubuntu dock and desktop icons. Screenshots are saved to
`build/screenshots`.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
