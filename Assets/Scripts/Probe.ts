@component
export class Probe extends BaseScriptComponent {
  onAwake() { this.createEvent("OnStartEvent").bind(() => this.run()); }

  private dump(label: string, obj: any) {
    if (!obj) { print(label + ": undefined"); return; }
    const ks: string[] = [];
    for (const k in obj) { ks.push(k + "=" + obj[k]); }
    print(label + " [" + ks.length + "]: " + ks.join(", "));
  }

  run() {
    print("=== PROBE 4: camera config surface ===");
    const G: any = global as any;
    const CM = G.CameraModule;
    this.dump("ConfigKey", CM.ConfigKey);
    this.dump("MetadataKey", CM.MetadataKey);
    this.dump("CameraType", CM.CameraType);
    this.dump("ImageFormat", CM.ImageFormat);
    this.dump("CameraId", CM.CameraId);

    const camModule: any = require("LensStudio:CameraModule");
    print("getSupportedStreams: " + (typeof camModule.getSupportedStreams));
    try {
      const streams = camModule.getSupportedStreams();
      print("supported streams count: " + (streams ? streams.length : "null"));
    } catch (e) { print("getSupportedStreams threw: " + e); }

    // StreamConfigOverrides shape - what can be overridden?
    try {
      const ov = new CM.StreamConfigOverrides();
      const ks: string[] = [];
      for (const k in ov) { ks.push(k); }
      print("StreamConfigOverrides fields: " + ks.join(", "));
    } catch (e) { print("StreamConfigOverrides: " + e); }

    print("=== PROBE 4 END ===");
  }
}
