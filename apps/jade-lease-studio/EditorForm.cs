using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace JadeLeaseStudio;

internal sealed class EditorForm : Form
{
    const string EditorUrl = "https://studio.jade.local/editor.html";
    readonly WebView2 browser = new() { Dock = DockStyle.Fill };
    readonly JsonElement plan;
    readonly Func<object, Task<JsonElement>> save;
    bool saving, finished;
    string? requestId;
    string? previousPayload;
    internal string? SavedReviewId { get; private set; }

    internal EditorForm(JsonElement plan, Func<object, Task<JsonElement>> save)
    {
        this.plan = plan; this.save = save;
        Text = "Edit F18 highlight and text · Jade Lease Studio";
        Size = new Size(1260, 900); MinimumSize = new Size(1000, 720);
        StartPosition = FormStartPosition.CenterParent;
        Controls.Add(browser);
        Shown += async (_, _) =>
        {
            try
            {
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.DataRoot, "Editor"));
                await browser.EnsureCoreWebView2Async(env);
                var core = browser.CoreWebView2;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.SetVirtualHostNameToFolderMapping("studio.jade.local", Path.Combine(AppContext.BaseDirectory, "ui"), CoreWebView2HostResourceAccessKind.DenyCors);
                core.NavigationStarting += (_, e) => { if (e.Uri != EditorUrl) e.Cancel = true; };
                core.NewWindowRequested += (_, e) => e.Handled = true;
                core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
                core.WebMessageReceived += Receive;
                core.Navigate(EditorUrl);
            }
            catch (Exception e)
            {
                MessageBox.Show("The editor needs Microsoft Edge WebView2. " + e.Message, "Could not open editor");
                finished = true; Close();
            }
        };
        FormClosing += (_, e) =>
        {
            if (saving) { e.Cancel = true; return; }
            if (!finished && MessageBox.Show("Close the editor without saving these edits? Your previous review is kept.", "Close editor", MessageBoxButtons.OKCancel) != DialogResult.OK) e.Cancel = true;
        };
    }

    async void Receive(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (e.Source != EditorUrl || saving) return;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var message = doc.RootElement;
            switch (message.GetProperty("action").GetString())
            {
                case "ready":
                    await browser.ExecuteScriptAsync("window.loadPlan(" + plan.GetRawText() + ")");
                    break;
                case "cancel": Close(); break;
                case "save":
                    saving = true;
                    // Retain the id on an exact retry after a network timeout.
                    var payload = message.GetRawText();
                    if (payload != previousPayload) requestId = Guid.NewGuid().ToString();
                    previousPayload = payload;
                    var result = await save(new {
                        requestId, reviewId = plan.GetProperty("reviewId").GetString(),
                        sourceSha256 = plan.GetProperty("sourceSha256").GetString(),
                        outline = message.GetProperty("outline").Clone(), notes = message.GetProperty("notes").Clone()
                    });
                    SavedReviewId = result.GetProperty("id").GetString();
                    saving = false; finished = true; DialogResult = DialogResult.OK; Close();
                    break;
            }
        }
        catch (Exception ex)
        {
            saving = false;
            if (!IsDisposed && browser.CoreWebView2 is not null)
                await browser.ExecuteScriptAsync("window.saveFailed(" + JsonSerializer.Serialize(ex.Message) + ")");
        }
    }
}
