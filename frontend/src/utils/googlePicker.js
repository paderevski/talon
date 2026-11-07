// The Google Picker, loaded on demand from apis.google.com. The student
// picks Drive files and folders; with the drive.file scope, picking is what
// gives Talon access to them. Config comes from
// GET /api/connections/google_drive/picker: { accessToken, apiKey, appId }.

let loading = null;

function loadPickerApi() {
  if (window.google?.picker) {
    return Promise.resolve();
  }
  loading ??= new Promise((resolve, reject) => {
    const fail = () => {
      loading = null;
      reject(new Error("Could not load the Google Picker. Check your connection and try again."));
    };
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.onload = () => window.gapi.load("picker", { callback: resolve, onerror: fail });
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return loading;
}

// Resolves with the picked items [{ id, name }] ([] when cancelled).
export async function openDrivePicker({ accessToken, apiKey, appId }) {
  await loadPickerApi();
  const g = window.google.picker;
  return new Promise((resolve) => {
    const view = new g.DocsView(g.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(true);
    const picker = new g.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(apiKey)
      .setAppId(appId)
      .enableFeature(g.Feature.MULTISELECT_ENABLED)
      .setTitle("Choose what Talon can read")
      .setCallback((data) => {
        const action = data[g.Response.ACTION];
        if (action === g.Action.PICKED) {
          resolve((data[g.Response.DOCUMENTS] || []).map((doc) => ({ id: doc[g.Document.ID], name: doc[g.Document.NAME] })));
        } else if (action === g.Action.CANCEL) {
          resolve([]);
        }
      })
      .build();
    picker.setVisible(true);
  });
}
