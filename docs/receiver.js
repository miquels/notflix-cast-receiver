//
// Custom web receiver for Notflix.
//
// Chromecast firmware actually comes with two players built-in, the
// old MPL player, and the newer Shaka player. The Shaka player is
// only used for DASH and MPL for the rest (such as HLS).
//
// This code is a hack to route HLS streams to the built in Shaka
// player instead of MPL. The main reason is 5.1 surround pass-through
// support: Shaka has it, MPL does not.
//

// The version of shaka player included with the Chromecast firmware
// is 3.0.x. In that version the DASH manifest parser does not know
// about a lot oftrack properties (like 'FORCED', 'NAME' etc).
// Because shaka is normally only used for dash, the firmware does not
// even look at fields that are present in HLS manifests.
//
// We only have 'language' and 'roles' to work with.
// In addition, 'language' is a unique key (so there can be only one).
//
// So what we do is, we rewrite the m3u8 file as soon as we receive it:
// - make duplicate languages unique (by adding a suffix like '-XY')
// - smuggle extra data in 'roles' (CHARACTERISTICS in HLS).
//
// Then we also intercept MEDIA_INFO response messages to the cast sender, and
// fix up the track definitions with the extra data we put in CHARACTERISTICS.
function manifestRewriter(m3u8) {

  // Split up the manifest into lines and parse them.
  const lines = m3u8.split(/\r?\n/);
  const state = {};
  let numUpdated = 0;
  for (let idx = 0; idx < lines.length; idx += 1) {

    // We're looking for #EXT-X-MEDIA.
    if (!lines[idx].startsWith('#EXT-X-MEDIA:')) {
      continue;
    }

    // Split up into key/value.
    let kv = {};
    let line = lines[idx].slice(13);
    while (line.length > 0) {
      let quoted = true;
      let res = line.match(/^([A-Za-z0-9_-]+)="([^"]*)"\s*,?(.*)$/);
      if (!res) {
        quoted = false;
        res = line.match(/^([A-Za-z0-9_-]+)=([^,]*)\s*,?(.*)$/);
      }
      if (!res) {
        break;
      }
      kv[res[1]] = { value: res[2], quoted };
      line = res[3];
    }

    // Must be TYPE=SUBTITLES or TYPE=AUDIO.
    if (!kv.TYPE || (kv.TYPE.value !== 'SUBTITLES' && kv.TYPE.value !== 'AUDIO')) {
      continue;
    }

    // Now stuff data into CHARACTERISTICS.
    const obj = {};
    for (let key of ['LANGUAGE', 'NAME', 'FORCED', 'CHANNELS']) {
      if (kv[key]) obj[key] = kv[key].value;
    }
    let ch = kv.CHARACTERISTICS ? kv.CHARACTERISTICS.value.split(/,/) : [];
    ch.push(`xyzzy.obj.${encodeObject(obj)}`);
    kv.CHARACTERISTICS = { value: ch.join(','), quoted: true };

    // And make the language unique.
    kv.LANGUAGE = { value: langTag(state, kv), quoted: true };

    // Now rebuild the #EXT-X-MEDIA line.
    let kvn = [];
    for (const [key, { quoted, value }] of Object.entries(kv)) {
      if (quoted) {
        kvn.push(`${key}="${value}"`);
      } else {
        kvn.push(`${key}=${value}`);
      }
    }
    lines[idx] = '#EXT-X-MEDIA:' + kvn.join(',');
	numUpdated += 1;
  }
  if (numUpdated) {
    console.log(`manifestRewriter: updated ${numUpdated} lines in m3u8`);
  }
  return lines.join('\n');
}

// Create a tag to add to LANGUAGE to make it unique.
// This is kind of course for now, we should really make sure
// that equivalent tracks in different AUDIO renditions have
// the same tags.
//
// So, for example:
// 1. en -> en
// 2. en -> en-XA
// 3. en -> en-XB
// ... etc
//
function langTag(state, kv) {
  const gid = kv['GROUP-ID'] ? kv['GROUP-ID'].value : 'gid';
  const lang = kv['LANGUAGE'] ? kv['LANGUAGE'].value : 'und';
  let tagSeq = 0;
  const key = `${gid}.${lang}`;

  // See if this is a dup.
  if (!state[key]) {
    state[key] = 1;
  } else {
	tagSeq = state[key];
    state[key] += 1;
  }
  
  // No dup (yet)?
  if (tagSeq === 0) {
    return lang;
  }

  // Use X[A-Z] and Q[B-Z].
  let firstLetter = 88;
  if (tagSeq > 26) {
    tagseq -= 25;
	firstLetter = 81;
  }
  if (tagSeq > 26) {
    tagSeq = 26;
  }
  const tag = String.fromCharCode(firstLetter, 64 + tagSeq);
  return `${lang}-${tag}`;
}

// Small try/catch wrapper to make sure we don't crash.
function tracksUpdater(resp) {
  if (!resp.media || !resp.media.tracks) {
    return resp;
  }
  try {
    resp = doTracksUpdate(resp);
  } catch(e) {
    console.log('tracksUpdater: error', e);
  }
  return resp;
}

// This is called when the receiver returns a MEDIA_STATUS response to a sender.
// We use it to update the tracks with the data we hid in `roles` earlier.
function doTracksUpdate(resp) {

  // Loop over all tracks.
  for (t of resp.media.tracks) {

    // Must have 'roles' set.
    if (!t.roles) continue;

    // Check every role to see if it starts with xyzzy.obj.
    for (let i = 0; i < t.roles.length; i += 1) {
      if (!t.roles[i].startsWith('xyzzy.obj.')) {
        continue;
      }

      // Decode the object we hid in here.
      const obj = decodeObject(t.roles[i].slice(10));
      if (obj.LANGUAGE) {
        t.language = obj.LANGUAGE;
      } else if (t.language && t.language.startsWith('und')) {
	    t.language = null;
	  }
      if (obj.NAME) {
        t.name = obj.NAME;
      }
      if (obj.FORCED) {
        t.roles.push('forced_subtitle');
        t.forced = true;
      }
      if (obj.CHANNELS) {
        t.channelCount = obj.CHANNELS;
      }

      // Finally, remove the fake role.
      t.roles.splice(i, 1);
      if (t.roles.length === 0) {
        delete t.roles;
      }
      break;
    }
  }

  return resp;
}

// Override shaka.Player.load() so that we have a hook into shaka.
function interceptPlayerLoad(interceptor) {
  const _load = shaka.Player.prototype.load;
  shaka.Player.prototype.load = function(...args) {
    if (!this._didIntercept) {
      interceptor.apply(this);
      this._didIntercept = true;
    }
    return _load.apply(this, args);
  };
}

// Initialize and start receiver.
function start() {
  const instance = cast.framework.CastReceiverContext.getInstance();

  // Cast receiver options.
  const options = new cast.framework.CastReceiverOptions();
  options.disableIdleTimeout = true;
  options.supportedCommands = cast.framework.messages.Command.ALL_BASIC_MEDIA;

  // Shaka player options.
  const shakaPlayerConfig = {
    preferredAudioChannelCount: 6,
  };

  // Load a debugging shaka player.
  // const cdn = 'https://cdnjs.cloudflare.com/ajax/libs/';
  // options.shakaUrl = cdn + 'shaka-player/3.0.15/shaka-player.compiled.js';
  // options.shakaUrl = cdn + 'shaka-player/3.0.13/shaka-player.compiled.debug.js';

  // When the system is READY, monkey patch shaka.Player.
  // We use it to:
  // - configure shaka player
  // - intercept and rewrite m3u8 manifest responses.
  instance.addEventListener(cast.framework.system.EventType.READY, () => {
    interceptPlayerLoad(function() {

      this.configure(shakaPlayerConfig);
      this.getNetworkingEngine().registerResponseFilter((type, response) => {
        if (type !== shaka.net.NetworkingEngine.RequestType.MANIFEST ||
             (!response.uri.endsWith('master.m3u8') && !response.uri.endsWith('main.m3u8')) ||
             (response.status && parseInt(response.status / 100, 10) !== 2)) {
           return;
        }
        // Guard against bugs / input that triggers bugs.
        try {
          const m3u8 = manifestRewriter(shaka.util.StringUtils.fromUTF8(response.data));
          response.data = shaka.util.StringUtils.toUTF8(m3u8);
        } catch(e) {
		  console.log('error while rewriting manifest:', e);
		}
      });

	  // On all manifest requests, add a custom header.
      this.getNetworkingEngine().registerRequestFilter((type, request) => {
        if (type === shaka.net.NetworkingEngine.RequestType.MANIFEST) {
		   request.headers['x-application'] = 'Notflix';
		}
      });
    });
  });

  // Intercept MEDIA_STATUS responses.
  const playerManager = instance.getPlayerManager();
  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.MEDIA_STATUS,
    tracksUpdater,
  );

  // Intercept LOAD requests.
  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, req => {
    if (req.media) {
      const contentId = req.media.contentId || '';
      const contentUrl = req.media.contentUrl || '';
      const m3u8 = new RegExp('\.m3u8(|\\?.*)$');
      if (contentId.match(m3u8) || contentUrl.match(m3u8)) {
	    // Setting content-type to DASH here forces the Chromecast
		// firmware to handle the video with Shaka player. Shaka
		// itself looks at the file extension first, mime-type second,
		// so will actually play HLS.
        req.media.contentType = 'application/dash+xml';
      }
	}
    return req;
  });

  // And start.
  instance.start(options);
}

// Helper functions.
// See https://developer.mozilla.org/en-US/docs/Glossary/Base64
function encodeObject(obj) {
  let m = unescape(encodeURIComponent(JSON.stringify(obj)));
  if (typeof window !== 'undefined') {
    return window.btoa(m);
  }
  return Buffer.from(m).toString('base64');
}
function decodeObject(str) {
  let m;
  if (typeof window !== 'undefined') {
    m = window.atob(str);
  } else {
    m = Buffer.from(str, 'base64').toString();
  }
  return JSON.parse(decodeURIComponent(escape(m)));
}

/*
function testIt() {
  const data =
`# Created by mp4lib.rs
#
#EXT-X-VERSION:6

# AUDIO
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio/mp4a.40.2",CHANNELS="2",NAME="English - Stereo",LANGUAGE="en",AUTOSELECT=YES,DEFAULT=NO,URI="media.2.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio/ac-3",CHANNELS="6",NAME="English - 5.1 Channel",LANGUAGE="en",AUTOSELECT=YES,DEFAULT=NO,URI="media.3.m3u8"

# SUBTITLES
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="German",LANGUAGE="de",AUTOSELECT=YES,DEFAULT=NO,URI="media.13.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",AUTOSELECT=YES,DEFAULT=NO,URI="media.5.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English (forced)",LANGUAGE="en",FORCED=YES,AUTOSELECT=YES,DEFAULT=NO,URI="media.4.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English (SDH)",LANGUAGE="en",CHARACTERISTICS="public.accessibility.describes-music-and-sound",AUTOSELECT=YES,DEFAULT=NO,URI="media.6.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Español",LANGUAGE="es",AUTOSELECT=YES,DEFAULT=NO,URI="media.15.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Español",LANGUAGE="es",AUTOSELECT=YES,DEFAULT=NO,URI="media.16.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Français",LANGUAGE="fr",AUTOSELECT=YES,DEFAULT=NO,URI="media.19.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Français",LANGUAGE="fr",AUTOSELECT=YES,DEFAULT=NO,URI="media.20.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Nederlands",LANGUAGE="nl",AUTOSELECT=YES,DEFAULT=NO,URI="media.31.m3u8"

# VIDEO
#EXT-X-STREAM-INF:AUDIO="audio/mp4a.40.2",BANDWIDTH=376205,SUBTITLES="subs",CODECS="avc1.640020,mp4a.40.2",RESOLUTION=1356x678,FRAME-RATE=23.976
media.1.m3u8
#EXT-X-STREAM-INF:AUDIO="audio/ac-3",BANDWIDTH=424665,SUBTITLES="subs",CODECS="avc1.640020,ac-3",RESOLUTION=1356x678,FRAME-RATE=23.976
media.1.m3u8
`;
  const x = manifestRewriter(data);
  console.log(x);
}
testIt();
*/

start();
