using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace JadeLeaseStudio;

internal static class Program
{
    internal static readonly string InstallRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Jade Lease Studio", "App");
    internal static readonly string DataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Jade Lease Studio", "Data");
    internal static readonly string OutputRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Jade Lease Plans");
    internal const string Site = "https://jade-agent.vercel.app";

    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        using var mutex = new Mutex(true, @"Local\JadeLeaseStudio-F18-v1", out var first);
        if (!first)
        {
            MessageBox.Show("Jade Lease Studio is already running. Open it from the Jade icon beside the Windows clock.", "Jade Lease Studio");
            return;
        }
        try
        {
            if (!Path.GetFullPath(AppContext.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar).Equals(InstallRoot, StringComparison.OrdinalIgnoreCase)
                && !args.Contains("--portable"))
            {
                if (MessageBox.Show("Install Jade Lease Studio for this Windows account?\n\nIt will start at sign-in and let Jade Agent prepare Palm Square F18 plans on this computer. You can turn automatic startup off inside the app. No administrator access is needed.", "Install Jade Lease Studio", MessageBoxButtons.OKCancel, MessageBoxIcon.Information) != DialogResult.OK) return;
                Directory.CreateDirectory(InstallRoot);
                foreach (var source in Directory.EnumerateFiles(AppContext.BaseDirectory, "*", SearchOption.AllDirectories))
                {
                    var destination = Path.Combine(InstallRoot, Path.GetRelativePath(AppContext.BaseDirectory, source));
                    Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                    File.Copy(source, destination, true);
                }
                SetStartup(true);
                var shortcutType = Type.GetTypeFromProgID("WScript.Shell");
                if (shortcutType is not null)
                {
                    dynamic shell = Activator.CreateInstance(shortcutType)!;
                    dynamic shortcut = shell.CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Jade Lease Studio.lnk"));
                    shortcut.TargetPath = Path.Combine(InstallRoot, "JadeLeaseStudio.exe");
                    shortcut.WorkingDirectory = InstallRoot;
                    shortcut.Save();
                }
                mutex.ReleaseMutex();
                Process.Start(new ProcessStartInfo(Path.Combine(InstallRoot, "JadeLeaseStudio.exe")) { UseShellExecute = true });
                return;
            }
            Directory.CreateDirectory(DataRoot);
            Directory.CreateDirectory(OutputRoot);
            Application.Run(new StudioForm(args.Contains("--background")));
        }
        catch (Exception e)
        {
            MessageBox.Show(e.Message, "Jade Lease Studio could not start", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    internal static bool StartupEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
        return key?.GetValue("JadeLeaseStudio") is string;
    }
    internal static void SetStartup(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
        if (enabled) key.SetValue("JadeLeaseStudio", $"\"{Path.Combine(InstallRoot, "JadeLeaseStudio.exe")}\" --background");
        else key.DeleteValue("JadeLeaseStudio", false);
    }
    internal static void Open(string path) => Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
}

internal sealed record Review(string id, string tenant, string date, string folder, string pdf, string dwg, string paper, string[] checks)
{
    public override string ToString() => $"{tenant} · {date}";
}

internal sealed class StudioForm : Form
{
    readonly Color jade = Color.FromArgb(0, 112, 100);
    readonly Label status = new() { AutoSize = false, Height = 52 };
    readonly Label sourceLabel = new() { AutoSize = false, Height = 60, Text = "Choose an F18 DWG, or locate the latest drawing in Jade Agent." };
    readonly TextBox tenant = new() { MaxLength = 70, PlaceholderText = "Tenant name" };
    readonly DateTimePicker date = new() { Format = DateTimePickerFormat.Custom, CustomFormat = "dd MMMM yyyy", MinDate = new DateTime(2000, 1, 1), MaxDate = new DateTime(2100, 12, 31) };
    readonly Button generate = new() { Text = "Create DWG and PDF", Height = 44, Enabled = false };
    readonly Button pick = new() { Text = "Open F18 DWG…", Height = 38 };
    readonly Button openPdf = new() { Text = "Open PDF", AutoSize = true, Enabled = false };
    readonly Button editPlan = new() { Text = "Edit highlight and text", AutoSize = true, Enabled = false };
    readonly Button openFolder = new() { Text = "Show saved files", AutoSize = true, Enabled = false };
    readonly ComboBox reviews = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 360 };
    readonly Label reviewInfo = new() { Dock = DockStyle.Top, Height = 64, Padding = new Padding(14), Text = "Your checked lease plan will appear here." };
    readonly WebView2 preview = new() { Dock = DockStyle.Fill };
    readonly NotifyIcon tray;
    readonly System.Windows.Forms.Timer timer = new() { Interval = 5000 };
    readonly HttpClient client = new() { Timeout = TimeSpan.FromMinutes(5) };
    Process? worker;
    string token = "", sourcePath = "", previewPath = "";
    string tokenFile = Path.Combine(Program.DataRoot, "desktop-token.txt");
    bool busy, polling, quitting, ready, webReady;
    int startupFailures;
    bool isBackground;

    internal StudioForm(bool background)
    {
        isBackground = background;
        Text = "Jade Lease Studio · F18 pilot";
        Size = new Size(1200, 850);
        MinimumSize = new Size(980, 720);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 10);
        BackColor = Color.FromArgb(244, 247, 247);
        Icon = SystemIcons.Application;
        var header = new Panel { Dock = DockStyle.Top, Height = 92, BackColor = jade, Padding = new Padding(24, 14, 24, 14) };
        header.Controls.Add(new Label { Text = "Palm Square / First floor / F18", Dock = DockStyle.Bottom, Height = 24, ForeColor = Color.White });
        header.Controls.Add(new Label { Text = "Jade Lease Studio", Dock = DockStyle.Top, Height = 36, ForeColor = Color.White, Font = new Font("Segoe UI", 21, FontStyle.Bold) });
        var body = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(20) };
        body.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 340));
        body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        var left = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(0, 0, 18, 0) };
        void Add(Control c) { c.Width = 302; c.Margin = new Padding(0, 0, 0, 12); left.Controls.Add(c); }
        Label Heading(string text) => new() { Text = text, Height = 28, Font = new Font(Font, FontStyle.Bold) };
        Add(Heading("Connected to Jade Agent"));
        Add(status);
        var site = new Button { Text = "Find the latest F18 in Jade Agent", Height = 42 };
        site.Click += (_, _) => Program.Open(Program.Site + "/lease-plans?studio=f18");
        Add(site);
        Add(new Label { Text = "Sign in on the website to locate the drawing. This app connects automatically while running.", Height = 62 });
        Add(Heading("Or prepare a local drawing"));
        Add(pick); Add(sourceLabel); Add(tenant); Add(date); Add(generate);
        Add(new Label { Text = "Keeps the existing F18 outline and scale. Saves new files; your source stays unchanged.", Height = 65 });
        var startup = new CheckBox { Text = "Start when I sign into Windows", Checked = Program.StartupEnabled(), Height = 30 };
        startup.CheckedChanged += (_, _) => { try { Program.SetStartup(startup.Checked); } catch (Exception e) { MessageBox.Show(e.Message); } };
        Add(startup);
        Add(new Label { Text = "Closing this window keeps the connection running beside the Windows clock. The PC must be awake.", Height = 66, ForeColor = Color.DimGray });
        var licenses = new LinkLabel { Text = "About and open-source licences", Height = 28 };
        licenses.LinkClicked += (_, _) => Program.Open(Path.Combine(AppContext.BaseDirectory, "THIRD-PARTY-NOTICES.txt"));
        Add(licenses);
        var right = new Panel { Dock = DockStyle.Fill, BackColor = Color.White };
        var toolbar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 92, Padding = new Padding(12), WrapContents = true };
        toolbar.Controls.Add(reviews); toolbar.SetFlowBreak(reviews, true); toolbar.Controls.Add(openPdf); toolbar.Controls.Add(openFolder); toolbar.Controls.Add(editPlan);
        right.Controls.Add(preview); right.Controls.Add(reviewInfo); right.Controls.Add(toolbar);
        body.Controls.Add(left, 0, 0); body.Controls.Add(right, 1, 0);
        Controls.Add(body); Controls.Add(header);
        generate.BackColor = jade; generate.ForeColor = Color.White; generate.FlatStyle = FlatStyle.Flat;
        editPlan.Click += async (_, _) => await EditPlan();
        pick.Click += (_, _) => ChooseSource();
        generate.Click += async (_, _) => await Generate();
        reviews.SelectedIndexChanged += async (_, _) => await ShowReview();
        openPdf.Click += (_, _) => { if (File.Exists(previewPath)) Program.Open(previewPath); };
        openFolder.Click += (_, _) => { if (reviews.SelectedItem is Review r) Program.Open(SafeFolder(r)); };
        tenant.TextChanged += (_, _) => UpdateButton();
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Jade Lease Studio", null, (_, _) => Restore());
        menu.Items.Add("Open Jade Agent", null, (_, _) => Program.Open(Program.Site + "/lease-plans?studio=f18"));
        menu.Items.Add("Quit and disconnect", null, (_, _) => Quit());
        tray = new NotifyIcon { Icon = Icon, Text = "Jade Lease Studio", Visible = true, ContextMenuStrip = menu };
        tray.DoubleClick += (_, _) => Restore();
        timer.Tick += async (_, _) => await Poll();
        Shown += async (_, _) =>
        {
            if (isBackground) Hide();
            StartWorker(); timer.Start();
            try
            {
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.DataRoot, "Preview"));
                await preview.EnsureCoreWebView2Async(env);
                preview.CoreWebView2.Settings.AreDevToolsEnabled = false;
                preview.CoreWebView2.Settings.IsScriptEnabled = false;
                preview.CoreWebView2.NewWindowRequested += (_, e) => e.Handled = true;
                preview.CoreWebView2.NavigationStarting += (_, e) =>
                {
                    if (string.IsNullOrEmpty(previewPath) || e.Uri != new Uri(previewPath).AbsoluteUri) e.Cancel = true;
                };
                webReady = true;
                if (File.Exists(previewPath)) preview.CoreWebView2.Navigate(new Uri(previewPath).AbsoluteUri);
            }
            catch { reviewInfo.Text = "PDF preview needs Microsoft Edge WebView2. You can still use Open PDF to review your plan."; }
            await Poll();
        };
        FormClosing += (_, e) => { if (!quitting) { e.Cancel = true; Hide(); } };
        FormClosed += (_, _) => { timer.Stop(); tray.Dispose(); StopWorker(); client.Dispose(); };
    }

    void Restore() { Show(); WindowState = FormWindowState.Normal; Activate(); }
    void Quit()
    {
        if (MessageBox.Show("Disconnect Jade Agent and stop drawing processing? Any unfinished job will stop. Completed files are kept.", "Quit Jade Lease Studio", MessageBoxButtons.OKCancel) != DialogResult.OK) return;
        quitting = true; Close();
    }
    void UpdateButton() => generate.Enabled = ready && !busy && File.Exists(sourcePath) && !string.IsNullOrWhiteSpace(tenant.Text);
    void ChooseSource()
    {
        using var dialog = new OpenFileDialog { Filter = "F18 drawing (*.dwg)|*.dwg", Title = "Open Palm Square F18 lease drawing", CheckFileExists = true };
        if (dialog.ShowDialog() != DialogResult.OK) return;
        sourcePath = dialog.FileName; sourceLabel.Text = Path.GetFileName(sourcePath); UpdateButton();
    }
    void StartWorker()
    {
        token = ""; ready = false;
        status.Text = "Starting the drawing engine…";
        try
        {
            File.Delete(tokenFile);
            var start = new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "runtime", "python.exe"))
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardError = true, RedirectStandardOutput = true };
            foreach (var arg in new[] { "-u", Path.Combine(AppContext.BaseDirectory, "worker", "studio_worker.py"), "--engine", Path.Combine(AppContext.BaseDirectory, "engine", "cadcraft-cli.exe"), "--output", Program.OutputRoot, "--desktop-token", tokenFile }) start.ArgumentList.Add(arg);
            worker = Process.Start(start) ?? throw new InvalidOperationException("Could not start the drawing engine.");
            worker.OutputDataReceived += (_, _) => { }; // Drain pipes, without recording private drawing data.
            worker.ErrorDataReceived += (_, _) => { };
            worker.BeginOutputReadLine(); worker.BeginErrorReadLine();
        }
        catch (Exception e) { status.Text = "Could not start: " + e.Message; startupFailures++; }
    }
    void StopWorker()
    {
        if (worker is null) return;
        try
        {
            if (!worker.HasExited)
            {
                worker.StandardInput.Close();
                if (!worker.WaitForExit(4000)) worker.Kill(entireProcessTree: true);
            }
        }
        catch (InvalidOperationException) { }
        worker.Dispose(); worker = null;
    }
    async Task<JsonElement> Request(string path, object? data = null)
    {
        using var req = new HttpRequestMessage(data is null ? HttpMethod.Get : HttpMethod.Post, "http://127.0.0.1:17819" + path);
        req.Headers.Add("Origin", Program.Site);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (data is not null)
        {
            req.Content = new StringContent(JsonSerializer.Serialize(data), Encoding.UTF8);
            req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        }
        using var response = await client.SendAsync(req);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException(json.RootElement.TryGetProperty("error", out var error) ? error.GetString() : "Could not complete the drawing request.");
        return json.RootElement.Clone();
    }
    async Task Poll()
    {
        if (polling || busy) return;
        polling = true;
        try
        {
            if (worker is null || worker.HasExited)
            {
                StopWorker();
                if (++startupFailures <= 3) StartWorker();
                else { ready = false; status.Text = "Drawing engine unavailable. Check that no other CAD helper is running, then restart Studio."; return; }
            }
            if (string.IsNullOrEmpty(token))
            {
                if (!File.Exists(tokenFile)) return;
                token = await File.ReadAllTextAsync(tokenFile);
            }
            await Request("/health");
            ready = true; startupFailures = 0; status.Text = "● Ready · Jade Agent connects automatically";
            await LoadReviews();
        }
        catch (Exception e) { ready = false; status.Text = e.Message; }
        finally { polling = false; UpdateButton(); }
    }
    async Task LoadReviews(string? selectId = null)
    {
        var data = await Request("/reviews");
        var list = JsonSerializer.Deserialize<Review[]>(data.GetProperty("reviews")) ?? [];
        var old = reviews.SelectedItem as Review;
        var changed = reviews.Items.Count != list.Length || (list.Length > 0 && (reviews.Items[0] as Review)?.id != list[0].id);
        if (!changed && selectId is null) return;
        reviews.BeginUpdate(); reviews.Items.Clear(); reviews.Items.AddRange(list); reviews.EndUpdate();
        var chosen = list.FirstOrDefault(r => r.id == selectId) ?? (changed ? list.FirstOrDefault() : list.FirstOrDefault(r => r.id == old?.id));
        if (chosen is not null) reviews.SelectedItem = chosen;
    }
    static string SafeFolder(Review r)
    {
        if (!Guid.TryParseExact(r.id, "D", out _)) throw new InvalidOperationException("Invalid saved review identifier.");
        return Path.Combine(Program.OutputRoot, r.id);
    }
    async Task ShowReview()
    {
        try
        {
            if (reviews.SelectedItem is not Review r) return;
            if (Path.GetFileName(r.pdf) != r.pdf || !r.pdf.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Invalid review filename.");
            previewPath = Path.Combine(SafeFolder(r), r.pdf);
            openPdf.Enabled = File.Exists(previewPath); openFolder.Enabled = true; editPlan.Enabled = !busy;
            reviewInfo.Text = $"{r.tenant} · {r.date}\n{r.paper} · Drawing checks passed. Review the outline and notes before use.";
            if (webReady) preview.CoreWebView2.Navigate(new Uri(previewPath).AbsoluteUri);
            await Task.CompletedTask;
        }
        catch (Exception e) { reviewInfo.Text = e.Message; }
    }
    async Task EditPlan()
    {
        if (busy || reviews.SelectedItem is not Review r) return;
        busy = true; editPlan.Enabled = false; pick.Enabled = false; reviews.Enabled = false; UpdateButton();
        status.Text = "Opening the highlight and text editor…";
        try
        {
            var plan = await Request("/studio/open", new { reviewId = r.id });
            using var editor = new EditorForm(plan, data => Request("/studio/edit", data));
            editor.ShowDialog(this);
            if (editor.SavedReviewId is not null) await LoadReviews(editor.SavedReviewId);
            status.Text = editor.SavedReviewId is null ? "Ready · previous review kept" : "Edited DWG and PDF saved for review";
        }
        catch (Exception e) { MessageBox.Show(e.Message, "Could not edit this plan"); }
        finally { busy = false; editPlan.Enabled = true; pick.Enabled = true; reviews.Enabled = true; UpdateButton(); }
    }
    async Task Generate()
    {
        busy = true; editPlan.Enabled = false; pick.Enabled = false; tenant.Enabled = false; date.Enabled = false; UpdateButton();
        status.Text = "Updating F18 and checking the saved DWG…";
        try
        {
            if (new FileInfo(sourcePath).Length > 24 * 1024 * 1024) throw new InvalidOperationException("Please choose a DWG smaller than 24 MB.");
            var raw = await File.ReadAllBytesAsync(sourcePath);
            var result = await Request("/generate", new {
                requestId = Guid.NewGuid().ToString(), tenant = tenant.Text.Trim(), date = date.Value.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
                project = "Palm Square", unit = "F18", source = new { name = Path.GetFileName(sourcePath), size = raw.Length }, dwg = Convert.ToBase64String(raw)
            });
            await LoadReviews(result.GetProperty("id").GetString());
            status.Text = "Ready for review · DWG and PDF saved";
        }
        catch (Exception e) { status.Text = "Review not completed"; MessageBox.Show(e.Message, "Check the drawing", MessageBoxButtons.OK, MessageBoxIcon.Information); }
        finally { busy = false; editPlan.Enabled = reviews.SelectedItem is Review; pick.Enabled = true; tenant.Enabled = true; date.Enabled = true; UpdateButton(); }
    }
}
