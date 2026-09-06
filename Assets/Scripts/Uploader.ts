/**
 * Sends a finished board to the board server.
 *
 * Delivery pushes rather than pulls: the wearer cannot scan a code off their own
 * glasses, so the board lands at a stable URL the user already has open instead.
 */
export class Uploader {

  /**
   * POST the SVG. `endpoint` is the base URL of the deployed server, e.g.
   * "https://insitu.vercel.app" — the key identifies which board to overwrite.
   */
  static send(
    endpoint: string,
    key: string,
    email: string,
    svg: string,
    onDone: (viewUrl: string, mailed: boolean, why: string) => void,
    onFail: (msg: string) => void
  ) {
    if (!endpoint) { onFail("no endpoint configured"); return; }

    const base = endpoint.charAt(endpoint.length - 1) === "/"
      ? endpoint.substr(0, endpoint.length - 1)
      : endpoint;
    let url = base + "/api/board?key=" + encodeURIComponent(key);
    if (email) url += "&email=" + encodeURIComponent(email);

    let internet: any;
    try {
      internet = require("LensStudio:InternetModule");
    } catch (e) {
      onFail("InternetModule unavailable: " + e);
      return;
    }

    const request = new Request(url, {
      method: "POST",
      body: svg,
      headers: { "Content-Type": "image/svg+xml" },
    });

    print("[Upload] POST " + url + "  (" + svg.length + " chars)");

    internet.fetch(request)
      .then((response: any) => {
        if (!response.ok) {
          onFail("server said " + response.status);
          return null;
        }
        return response.text();
      })
      .then((body: string) => {
        if (body === null || body === undefined) return;
        let view = base + "/b/" + key;
        try {
          const parsed = JSON.parse(body);
          if (parsed && parsed.view) view = parsed.view;
        } catch (e) {
          // a non-JSON 200 still means it landed; fall back to the conventional URL
        }
        // The server reports whether the mail actually went. Reporting only the
        // upload and saying "Sent to <address>" regardless is how a board came back
        // "sent" while no email was ever configured - the caller has to be told.
        let mailed = false, why = "not requested";
        try {
          const p2 = JSON.parse(body);
          if (p2 && p2.mail) {
            mailed = p2.mail.sent === true;
            why = p2.mail.reason ? p2.mail.reason : (mailed ? "sent" : "unknown");
          }
          if (p2 && p2.durable === false) {
            print("[Upload] WARNING board store is not durable - it will not survive"
                  + " the server going cold. Set BLOB_READ_WRITE_TOKEN.");
          }
        } catch (e) { /* a non-JSON 200 still means it landed */ }
        if (!mailed && why !== "not requested") print("[Upload] mail not sent: " + why);
        onDone(view, mailed, why);
      })
      .catch((e: any) => onFail("request failed: " + e));
  }
}
