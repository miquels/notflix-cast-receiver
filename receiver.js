//
// In recent versions of the Chromecast firmware it is possible
// configure the web receiver so that it uses Shaka for HLS playback.
//

// Initialize and start receiver.
function start() {
  const instance = cast.framework.CastReceiverContext.getInstance();

  // Cast receiver options.
  const options = new cast.framework.CastReceiverOptions();
  options.disableIdleTimeout = true;
  options.supportedCommands = cast.framework.messages.Command.ALL_BASIC_MEDIA;
  options.useShakaForHls = true;
  options.skipMplLoad = true;

  // Playback config.
  const playbackConfig = new cast.framework.PlaybackConfig();
  options.playbackConfig = playbackConfig;

  // Set shaka player options.
  playbackConfig.shakaConfig = {
    preferredAudioChannelCount: 6,
  };

  // Intercept http request to set custom headers.
  playbackConfig.manifestRequestHandler = (request) => {
    request.headers['x-application'] = 'Notflix';
  };

  // Load a debugging shaka player.
  // const cdn = 'https://cdnjs.cloudflare.com/ajax/libs/';
  // options.shakaUrl = cdn + 'shaka-player/3.0.15/shaka-player.compiled.js';
  // options.shakaUrl = cdn + 'shaka-player/3.0.13/shaka-player.compiled.debug.js';

  // When media is loaded, adjust text track style.
  instance.addEventListener(
    cast.framework.events.EventType.TEXT_TRACKS_AVAILABLE, () => {
      const playerManager = instance.getPlayerManager();
      const textTracksManager = playerManager.getTextTracksManager();
      let style = {
        backgroundColor: "#00000000",
        edgeColor: "#000000FF",
        edgeType: "DROP_SHADOW",
        fontFamily: "Droid Serif Regular",
        fontGenericFamily: "SERIF",
        fontScale: 1,
        foregroundColor: "#FFFFFFFF",
      };
      textTracksManager.setTextTrackStyle(style);
    }
  );

  // And start.
  instance.start(options);
}

start();
