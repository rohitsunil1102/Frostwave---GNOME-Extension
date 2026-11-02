// SPDX-License-Identifier: GPL-2.0-or-later

// Music services that Frostwave recognises out of the box. Other MPRIS
// players (browsers, video players, ...) are only shown when "Other Media
// Players" is enabled.

export const MUSIC_SERVICES = [
    {
        name: 'Spotify',
        // The official client, plus the spotifyd and ncspot clients.
        busName: /^org\.mpris\.MediaPlayer2\.(spotify|spotifyd|ncspot)(\.|$)/i,
        identity: /(?:^|\.)spotify(?:$|[-_. ])/i,
        url: /^https?:\/\/(?:open\.)?spotify\.com\//i,
        // Snap, Flatpak and distribution packages of the Spotify client
        desktopIds: [
            'spotify_spotify.desktop',
            'com.spotify.Client.desktop',
            'spotify.desktop',
        ],
    },
    {
        name: 'YouTube Music',
        busName: /^org\.mpris\.MediaPlayer2\.(youtube-music|youtube-music-desktop|youtube-music-desktop-app|youtube_music|youtubemusic|ytmusic|ytmdesktop)(\.|$)/i,
        // th-ch's app reports its desktop ID ("com.github.th_ch.youtube_music")
        // as the Identity instead of a display name.
        identity: /(?:^|\.)(?:youtube[-_. ]?music|ytmusic|ytmdesktop)(?:$|[-_. ])/i,
        url: /^https?:\/\/music\.youtube\.com\//i,
        desktopIds: [
            'youtube-music.desktop',
            'youtube-music-desktop-app.desktop',
            'youtubemusic.desktop',
            'ytmdesktop.desktop',
            'app.ytmdesktop.ytmdesktop.desktop',
            'com.github.th_ch.youtube_music.desktop',
        ],
    },
    {
        name: 'Deezer',
        busName: /^org\.mpris\.MediaPlayer2\.(deezer|deezer-desktop|deezerdesktop)(\.|$)/i,
        identity: /(?:^|\.)deezer(?:$|[-_. ])/i,
        url: /^https?:\/\/(?:www\.)?deezer\.com\//i,
        desktopIds: [
            'dev.aunetx.deezer.desktop',
            'deezer.desktop',
            'deezer-desktop.desktop',
        ],
    },
];

/**
 * @param {string} busName - the player's well-known MPRIS bus name
 * @returns {object|null} the matching service
 */
export function serviceForBusName(busName) {
    return MUSIC_SERVICES.find(service => service.busName.test(busName)) ?? null;
}

/**
 * @param {string} url - a track URL published by the player
 * @returns {object|null} the matching service
 */
export function serviceForUrl(url) {
    return MUSIC_SERVICES.find(service => service.url.test(url)) ?? null;
}

/**
 * @param {string} identity - the player's Identity property
 * @returns {object|null} the matching service
 */
export function serviceForIdentity(identity) {
    return MUSIC_SERVICES.find(service => service.identity.test(identity)) ?? null;
}

/**
 * @param {string} desktopEntry - the player's DesktopEntry property
 * @returns {object|null} the matching service
 */
export function serviceForDesktopEntry(desktopEntry) {
    if (!desktopEntry)
        return null;

    const id = `${desktopEntry}.desktop`;
    return MUSIC_SERVICES.find(service => service.desktopIds.includes(id)) ?? null;
}
