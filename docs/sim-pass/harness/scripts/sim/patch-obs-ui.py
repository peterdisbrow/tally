import sys
R='/workspace/tally/'
def rep(p, old, new, count=1):
    s=open(R+p).read()
    if old not in s: sys.exit(f'MISSING in {p}: {old[:60]}')
    s=s.replace(old,new,count); open(R+p,'w').write(s)
rep('electron-app/src/renderer.js',"""  const fwVersion = encoderData.firmwareVersion || '';
  if (fwVersion) setStatusValue('val-encoder-firmware', fwVersion, true);""","""  // OBS reports its version via obs-websocket GetVersion (status.obs.version).
  const fwVersion = encoderData.firmwareVersion
    || (obsData.connected && obsData.version ? `OBS ${obsData.version}` : '');
  // Why the encoder/OBS is not connected (e.g. wrong OBS WebSocket password).
  // Shown only while disconnected; the agent clears it on successful connect.
  const encErrEl = document.getElementById('encoder-error');
  if (encErrEl) {
    const encErr = !encoderConnected ? (obsData.error || encoderData.error || '') : '';
    encErrEl.textContent = encErr ? `⚠ ${encErr}` : '';
    encErrEl.style.display = encErr ? 'block' : 'none';
  }
  if (fwVersion) setStatusValue('val-encoder-firmware', fwVersion, true);""")
rep('electron-app/src/index.html',"""      <!-- Stream quality details (resolution, framerate, ingest health) -->""","""      <div id="encoder-error" class="device-error-line" role="alert" style="display:none;"></div>
      <!-- Stream quality details (resolution, framerate, ingest health) -->""")
open(R+'electron-app/src/styles.css','a').write("""
/* Device connection failure reason (e.g. OBS auth failed) */
.device-error-line {
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(239, 68, 68, 0.12);
  color: #fca5a5;
  font-size: 12px;
}
""")
p='church-client/src/index.js'
rep(p,"""          try {
            const rs = await this.obs.call('GetRecordStatus');""","""          try {
            const sl = await this.obs.call('GetSceneList');
            // obs-websocket lists scenes bottom-up; the OBS UI shows them top-down.
            this.status.obs.scenes = Array.isArray(sl?.scenes)
              ? sl.scenes.map((x) => x.sceneName).filter(Boolean).reverse()
              : [];
            this.status.obs.currentScene = sl?.currentProgramSceneName || null;
          } catch { /* optional */ }
          try {
            const rs = await this.obs.call('GetRecordStatus');""")
rep(p,"""      this.obs.on('RecordStateChanged', ({ outputActive }) => {""","""      // Scene state for the booth's OBS scene switcher (Commands panel).
      this.obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
        this.status.obs.currentScene = sceneName || null;
        this.sendStatus();
      });
      this.obs.on('SceneListChanged', ({ scenes }) => {
        if (Array.isArray(scenes)) {
          this.status.obs.scenes = scenes.map((x) => x.sceneName).filter(Boolean).reverse();
          this.sendStatus();
        }
      });

      this.obs.on('RecordStateChanged', ({ outputActive }) => {""")
rep(p,"""        this.status.obs.fps = null;
        this._prevObsBytes = null;""","""        this.status.obs.fps = null;
        this.status.obs.currentScene = null;
        this._prevObsBytes = null;""")
rep(p,"""        connected: false, error: null,
        app: null,""","""        connected: false, error: null,
        scenes: [], currentScene: null,
        app: null,""")
print('ok')
