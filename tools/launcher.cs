// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using QRCoder;

static class NiuDesktop {
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [STAThread] static void Main(string[] args) {
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        bool created;
        using (Mutex mutex = new Mutex(true, "Local\\NIUWalletDesktopLocalAlpha", out created)) {
            if (!created) { MessageBox.Show(NiuLanguage.T("牛币钱包已打开，请使用已有窗口。"), NiuLanguage.T("牛币钱包")); return; }
            Application.Run(new WalletForm(Array.IndexOf(args, "--smoke-test") >= 0, Array.IndexOf(args, "--language-smoke-test") >= 0));
        }
    }
}


// Dogecoin-style connection indicator for the footer: four rising bars filled
// while the node has peers, a green check badge once the chain is fully synced.
class SignalBars : Control {
    public int Level; public bool Good;
    public SignalBars() { SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true); }
    protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics; g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        var active = Color.FromArgb(33, 77, 60); var idle = Color.FromArgb(211, 209, 197);
        int w = ClientSize.Width, h = ClientSize.Height;
        int bars = Math.Max(14, w - 16), barW = Math.Max(3, bars * 3 / 16), gap = Math.Max(2, bars / 16);
        for (int i = 0; i < 4; i++) {
            int bh = Math.Max(3, (i + 1) * (h - 4) / 4), x = i * (barW + gap);
            using (var b = new SolidBrush(i < Level ? active : idle)) g.FillRectangle(b, x, h - 2 - bh, barW, bh);
        }
        if (Good) {
            int d = Math.Max(12, h / 2), cx = w - d, cy = h - d;
            using (var b = new SolidBrush(active)) g.FillEllipse(b, cx, cy, d, d);
            using (var pen = new Pen(Color.White, Math.Max(1.6f, d / 6f))) {
                g.DrawLine(pen, cx + d * 0.28f, cy + d * 0.52f, cx + d * 0.45f, cy + d * 0.70f);
                g.DrawLine(pen, cx + d * 0.45f, cy + d * 0.70f, cx + d * 0.74f, cy + d * 0.30f);
            }
        }
    }
}

static class NiuLanguage {
    public static readonly string[] Codes={"zh-CN","en","ja","ko","es","ru"};
    public static readonly string[] Names={"简体中文","English","日本語","한국어","Español","Русский"};
    static readonly Dictionary<string,Dictionary<string,string>> catalogs=new Dictionary<string,Dictionary<string,string>>();
    static readonly string preference=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"NIUWallet","preferences.json");
    public static string Current;
    static NiuLanguage() {
        var json=new JavaScriptSerializer();
        foreach(string code in Codes) {
            using(var stream=System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream(code+".json")) {
                if(stream==null)throw new InvalidOperationException("Missing embedded language: "+code);
                using(var reader=new StreamReader(stream,Encoding.UTF8))catalogs[code]=json.Deserialize<Dictionary<string,string>>(reader.ReadToEnd());
            }
        }
        Current=ReadPreference();
        if(Current==null) {
            string system=System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName;
            Current=system=="zh"?"zh-CN":Array.IndexOf(Codes,system)>=0?system:"en";
        }
    }
    public static string ReadPreference() {
        try {
            if(!File.Exists(preference)||new FileInfo(preference).Length>4096)return null;
            var settings=new JavaScriptSerializer().Deserialize<Dictionary<string,string>>(File.ReadAllText(preference,Encoding.UTF8));
            string code;if(settings!=null&&settings.TryGetValue("language",out code)&&Array.IndexOf(Codes,code)>=0)return code;
        } catch(IOException) {} catch(UnauthorizedAccessException) {} catch(ArgumentException) {} catch(InvalidOperationException) {}
        return null;
    }
    public static void Save(string code) {
        if(Array.IndexOf(Codes,code)<0)throw new ArgumentException("Unsupported language");
        Directory.CreateDirectory(Path.GetDirectoryName(preference));
        string temporary=preference+"."+Guid.NewGuid().ToString("N")+".tmp";
        try {
            File.WriteAllText(temporary,new JavaScriptSerializer().Serialize(new {language=code}),new UTF8Encoding(false));
            if(File.Exists(preference))File.Replace(temporary,preference,null);else File.Move(temporary,preference);
        } finally {if(File.Exists(temporary))File.Delete(temporary);}
    }
    public static string Key(string text) {
        if(String.IsNullOrEmpty(text))return null;
        if(catalogs["zh-CN"].ContainsKey(text))return text;
        foreach(var language in catalogs.Values)foreach(var pair in language)if(pair.Value==text)return pair.Key;
        return null;
    }
    public static string T(string key) {
        string value;
        if(catalogs[Current].TryGetValue(key,out value))return value;
        if(catalogs["en"].TryGetValue(key,out value))return value;
        return key;
    }
}

class BanknotePanel : Panel {
    public BanknotePanel(){DoubleBuffered=true;}
    protected override void OnPaint(PaintEventArgs e){
        base.OnPaint(e);e.Graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        using(var ink=new Pen(Color.FromArgb(33,77,60),1))using(var gold=new Pen(Color.FromArgb(184,155,85),1)){
            e.Graphics.DrawRectangle(ink,1,1,Width-3,Height-3);e.Graphics.DrawRectangle(gold,7,7,Width-15,Height-15);
            foreach(int x in new int[]{17,Width-18})foreach(int y in new int[]{17,Height-18}){
                e.Graphics.DrawEllipse(ink,x-5,y-5,10,10);e.Graphics.DrawLine(gold,x-10,y,x+10,y);e.Graphics.DrawLine(gold,x,y-10,x,y+10);
            }
        }
    }
}

class WalletForm : Form {
    readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    readonly string endpoint = "http://127.0.0.1:18790";
    readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
    readonly bool smoke;
    string token, address = "", recipient = ""; bool ready, actionBusy, refreshing, closing, closeAfterReady, starting = true;
    Process backend; StreamWriter outputLog, errorLog;
    Dictionary<string, object> state;
    Panel workspace = new Panel();
    Panel navigation = new Panel();
    List<Panel> pages = new List<Panel>();
    List<Button> navButtons = new List<Button>();
    Label status = new Label(), balance = new Label(), height = new Label(), minerState = new Label(), peerState = new Label();
    Label netState = new Label();
    SignalBars netSignal = new SignalBars();
    bool chainNotified;
    Label overviewAddress = new Label(), receiveAddress = new Label(), contractAddress = new Label(), currentMessage = new Label(), result = new Label();
    Label backupWarning = new Label();
    TextBox sendTo = new TextBox(), amount = new TextBox(), message = new TextBox(), backupPath = new TextBox();
    Button send, mine, deploy, update, backup, fill;
    ListView transactions = new ListView();
    PictureBox receiveQr = new PictureBox();
    string qrAddress = "";
    ComboBox receiveAccounts = new ComboBox(), sendAccounts = new ComboBox(), contactBook = new ComboBox();
    string accountSignature = "", contactSignature = "";
    List<string> ownedAddresses = new List<string>(), contactAddresses = new List<string>();
    List<Button> buttons = new List<Button>();
    Button languageChoice = new Button();
    ContextMenuStrip languageMenu = new ContextMenuStrip();
    Dictionary<Control,string> languageText = new Dictionary<Control,string>();
    List<string> columnText = new List<string>();
    System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer();
    // Incoming-payment announcement: a tray balloon plus an in-window banner, so a
    // payment that arrives while the wallet sits in the background is not silent.
    NotifyIcon tray = new NotifyIcon();
    Panel incomingBanner = new Panel();
    Label incomingText = new Label(), recentList = new Label(), txDetailHash = new Label(), txDetailMeta = new Label();
    DateTime incomingBannerUntil = DateTime.MinValue;
    string selectedHash = "", txFilter = "all";
    readonly HashSet<string> notifiedIncoming = new HashSet<string>();
    bool incomingPrimed;
    // Display scale relative to the 96 DPI design grid; dialogs are separate
    // Forms outside the auto-scaled tree, so they scale their coordinates here.
    readonly float uiScale;
    int U(int v) { return (int)Math.Round(v * uiScale); }

    public WalletForm(bool test, bool languageTest = false) {
        smoke = test; Text = NiuLanguage.T("牛币钱包  NIU Wallet"); ClientSize = new Size(1180, 760); MinimumSize = new Size(1100, 740);
        StartPosition = FormStartPosition.CenterScreen; Font = new Font("Microsoft YaHei UI", 10); BackColor = Color.FromArgb(246,240,223);
        // The layout was drawn for 96 DPI only: on 125%/150% displays fonts grew
        // while the fixed pixel boxes stayed small, so text clipped and rows
        // overlapped. Scale the whole tree with the display DPI, and suspend
        // layout so auto-scaling runs once over the completed control tree.
        AutoScaleMode = AutoScaleMode.Dpi; AutoScaleDimensions = new SizeF(96F, 96F);
        uiScale = DeviceDpi / 96f;
        SuspendLayout();
        string iconPath = Path.Combine(root, "assets", "niu-gold-v4.ico");
        if (File.Exists(iconPath)) { Icon = new Icon(iconPath); try { tray.Icon = new Icon(iconPath); } catch { } }
        tray.Text = NiuLanguage.T("牛币钱包");
        // Only expose the tray icon when it actually has a bitmap; a NotifyIcon
        // without one can throw on some shells.
        if (tray.Icon != null) tray.Visible = true;
        var header = new Panel { Dock = DockStyle.Top, Height = 76, BackColor = Color.White, Padding = new Padding(24, 12, 24, 8) };
        string logoPath = Path.Combine(root, "assets", "niu-gold-v4.png");
        if (File.Exists(logoPath)) header.Controls.Add(new PictureBox { Image = Image.FromFile(logoPath), SizeMode = PictureBoxSizeMode.Zoom, Location = new Point(22, 13), Size = new Size(50, 50) });
        header.Controls.Add(new Label { Text = NiuLanguage.T("牛币钱包"), Font = new Font(Font.FontFamily, 18, FontStyle.Bold), AutoSize = true, Location = new Point(88, 20) });
        header.Controls.Add(new Label { Text = "NIU WALLET", Font = new Font("Segoe UI", 9, FontStyle.Bold), AutoSize = true, ForeColor = Color.FromArgb(123, 115, 91), Location = new Point(90, 52) });
        var motto = new Label { Text = NiuLanguage.T("慢慢来，也很牛。"), Dock=DockStyle.Right, Width=200, TextAlign=ContentAlignment.MiddleRight, ForeColor = Color.FromArgb(123, 115, 91) }; header.Controls.Add(motto);
        workspace.Dock = DockStyle.Fill; workspace.BackColor = Color.White;
        navigation.Dock = DockStyle.Left; navigation.Width = 182; navigation.BackColor = Color.FromArgb(237,238,224);
        navigation.Controls.Add(L(NiuLanguage.T("我的钱包"), 22, 24, 145, 9));
        var body = new Panel { Dock = DockStyle.Fill }; body.Controls.Add(workspace); body.Controls.Add(navigation);
        var footer = new Panel { Dock = DockStyle.Bottom, Height = 46, BackColor = Color.FromArgb(248, 247, 242), Padding = new Padding(20, 10, 20, 8) };
        status.AutoEllipsis = true; status.Dock = DockStyle.Fill; status.Text = NiuLanguage.T("正在启动本机节点并读取加密钱包…"); status.ForeColor = Color.FromArgb(82, 96, 61);
        netState.Dock = DockStyle.Right; netState.Width = 96; netState.TextAlign = ContentAlignment.MiddleRight;
        netState.Text = NiuLanguage.T("连接中…"); netState.ForeColor = Color.FromArgb(123,115,91); netState.Font = new Font(Font.FontFamily, 9); netState.AutoEllipsis = true;
        netSignal.Dock = DockStyle.Right; netSignal.Width = 40;
        footer.Controls.Add(status); footer.Controls.Add(netState); footer.Controls.Add(netSignal);
        Controls.Add(body); Controls.Add(header); Controls.Add(footer);
        BuildOverview(); BuildSend(); BuildReceive(); BuildTransactions(); BuildSettings();
        foreach(var combo in new ComboBox[]{receiveAccounts,sendAccounts,contactBook}){
            combo.DrawMode=DrawMode.OwnerDrawFixed;combo.ItemHeight=24;combo.DropDownWidth=840;
            combo.DrawItem+=delegate(object sender,DrawItemEventArgs e){
                e.DrawBackground();var box=(ComboBox)sender;
                string text=e.Index>=0&&e.Index<box.Items.Count?Convert.ToString(box.Items[e.Index]):NiuLanguage.T("请选择地址");
                TextRenderer.DrawText(e.Graphics,text,box.Font,e.Bounds,e.ForeColor,TextFormatFlags.Left|TextFormatFlags.VerticalCenter|TextFormatFlags.EndEllipsis);e.DrawFocusRectangle();
            };
        }
        SelectPage(0); SetEnabled();
        poll.Interval = 3000; poll.Tick += async delegate { await RefreshState(); };
        CaptureLanguageText(this);
        ApplyLanguage();
        ResumeLayout(true);
        if (languageTest) Shown += async delegate { await LanguageSmokeTest(); };
        else Shown += async delegate { await StartWallet(); };
        FormClosing += async delegate(object sender, FormClosingEventArgs e) {
            if (closing) return;
            e.Cancel = true;
            if (actionBusy) { Notify(NiuLanguage.T("操作尚未结束，请等待交易结果后关闭。"), true); return; }
            if (starting && backend != null && !backend.HasExited) { closeAfterReady = true; Notify(NiuLanguage.T("正在完成启动，随后会正常关闭节点。"), false); return; }
            await CloseWallet();
        };
    }
    protected override void OnShown(EventArgs e) {
        base.OnShown(e);
        // After DPI scaling the designed 1180x760 can exceed a small laptop
        // screen; shrink to the working area instead of letting the bottom (and
        // the taskbar overlap) cut the page off. Pages scroll for the rest.
        var work = Screen.FromControl(this).WorkingArea;
        int width = Math.Min(Width, work.Width), height = Math.Min(Height, work.Height);
        if (width != Width || height != Height) {
            Width = width; Height = height;
            MinimumSize = new Size(Math.Min(1100, work.Width), Math.Min(740, work.Height));
            CenterToScreen();
        }
    }
    Panel Page(string name) {
        int index = pages.Count; var p = new Panel { BackColor = Color.FromArgb(253,252,247), Padding = new Padding(24), Dock = DockStyle.Fill, Visible = false, AutoScroll = true }; pages.Add(p); workspace.Controls.Add(p);
        var nav = new Button { Text = name, Location = new Point(14,64 + index*54), Size = new Size(154,44), TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(16,0,0,0), FlatStyle = FlatStyle.Flat, BackColor = navigation.BackColor, ForeColor = Color.FromArgb(71,68,58), UseVisualStyleBackColor = false, Font = new Font(Font.FontFamily,10) };
        nav.FlatAppearance.BorderSize = 0; nav.Click += delegate { SelectPage(index); }; navButtons.Add(nav); navigation.Controls.Add(nav); return p;
    }
    void SelectPage(int index) { for(int i=0;i<pages.Count;i++){pages[i].Visible=i==index;navButtons[i].BackColor=i==index?Color.FromArgb(216,226,207):navigation.BackColor;navButtons[i].Font=new Font(Font.FontFamily,10,i==index?FontStyle.Bold:FontStyle.Regular);} pages[index].BringToFront(); }
    Label L(string text, int x, int y, int width = 900, int size = 10) {
        var font = new Font(Font.FontFamily, size);
        // Height follows the text as it actually wraps inside this width, so a
        // long or multi-line string is never clipped to a guessed 34px box.
        int height = Math.Max(34, TextRenderer.MeasureText(text, font, new Size(Math.Max(width - 4, 40), 100000), TextFormatFlags.WordBreak).Height + 8);
        var label = new Label { Text = text, Location = new Point(x, y), Size = new Size(width, height), Font = font, AutoEllipsis = true };
        // Single-line labels: let WinForms size the box to the real rendered
        // text (exact on every DPI), so the box can never clip the glyphs or
        // overlap the next row. Width stays capped so long one-liners wrap
        // instead of spilling out of the page.
        if (height <= 42) { label.AutoSize = true; label.MaximumSize = new Size(width, 0); }
        return label;
    }
    Button B(string text, int x, int y, EventHandler handler, int width = 155) { var b = new Button { Text = text, Location = new Point(x, y), Size = new Size(width, 42), BackColor = Color.FromArgb(33,77,60), ForeColor = Color.FromArgb(250,246,231), FlatStyle = FlatStyle.Flat, UseVisualStyleBackColor=false }; b.FlatAppearance.BorderSize = 0; b.Click += handler; buttons.Add(b); return b; }
    void BuildOverview() {
        var p = Page(NiuLanguage.T("概览")); p.Controls.Add(L(NiuLanguage.T("钱包概览"), 36, 30, 500, 19));
        var card=new BanknotePanel {Location=new Point(36,70),Size=new Size(850,160),BackColor=Color.FromArgb(246,240,223)};p.Controls.Add(card);
        var caption=L(NiuLanguage.T("钱包总余额"),20,14,600);caption.ForeColor=Color.FromArgb(73,101,80);caption.BackColor=card.BackColor;card.Controls.Add(caption);
        balance = L("— NIU", 20, 48, 600, 34);balance.Font=new Font("Georgia",34,FontStyle.Regular);balance.BackColor=card.BackColor;balance.ForeColor=Color.FromArgb(33,77,60);balance.Height = 78; card.Controls.Add(balance);
        string coinPath=Path.Combine(root,"assets","niu-gold-v4.png");if(File.Exists(coinPath))card.Controls.Add(new PictureBox {Image=Image.FromFile(coinPath),SizeMode=PictureBoxSizeMode.Zoom,Location=new Point(690,15),Size=new Size(130,130),BackColor=card.BackColor});
        // Incoming-payment banner. Hidden until a payment this wallet has not
        // announced before shows up confirmed in the ledger.
        incomingBanner = new Panel { Location = new Point(36, 240), Size = new Size(850, 46), BackColor = Color.FromArgb(222, 239, 214), Visible = false };
        incomingText = new Label { Location = new Point(14, 0), Size = new Size(786, 46), TextAlign = ContentAlignment.MiddleLeft, ForeColor = Color.FromArgb(33,77,60), Font = new Font(Font.FontFamily, 10, FontStyle.Bold), BackColor = Color.Transparent, AutoEllipsis = true };
        var dismiss = new Button { Text = "✕", Location = new Point(806, 7), Size = new Size(32, 32), FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(222, 239, 214), ForeColor = Color.FromArgb(33,77,60), UseVisualStyleBackColor = false, TabStop = false };
        dismiss.FlatAppearance.BorderSize = 0;
        dismiss.Click += delegate { incomingBanner.Visible = false; incomingBannerUntil = DateTime.MinValue; };
        incomingBanner.Controls.Add(incomingText); incomingBanner.Controls.Add(dismiss); p.Controls.Add(incomingBanner);
        p.Controls.Add(L(NiuLanguage.T("默认挖矿地址"), 36, 296)); overviewAddress = L(NiuLanguage.T("正在读取…"), 36, 324); overviewAddress.Font = new Font("Consolas", 11); p.Controls.Add(overviewAddress);
        p.Controls.Add(B(NiuLanguage.T("发送 NIU"),36,366,delegate {SelectPage(1);},150));
        p.Controls.Add(B(NiuLanguage.T("接收 NIU"),204,366,delegate {SelectPage(2);},150));
        mine = B(NiuLanguage.T("开启挖矿"), 372, 366, async delegate { await Action(NiuLanguage.T("正在切换挖矿状态…"), async delegate { bool enabled = state == null || !Convert.ToBoolean(state["mining"]); await Post("mine", new { enabled = enabled }); Notify(enabled ? NiuLanguage.T("已开启挖矿，请等待有效区块。") : NiuLanguage.T("挖矿已停止。"), false); }); }, 190); p.Controls.Add(mine);
        height = L(NiuLanguage.T("区块高度：—"), 36, 420); peerState = L(NiuLanguage.T("连接：—"), 36, 446); minerState = L(NiuLanguage.T("挖矿：—"), 36, 472);
        p.Controls.Add(height); p.Controls.Add(peerState); p.Controls.Add(minerState);
        p.Controls.Add(L(NiuLanguage.T("最近记录"), 36, 504, 500, 12));
        recentList = new Label { Text = NiuLanguage.T("暂无记录"), Location = new Point(36, 532), Size = new Size(850, 74), Font = new Font("Consolas", 9), ForeColor = Color.FromArgb(71,68,58), AutoEllipsis = true, AutoSize = true, MaximumSize = new Size(850, 0) };
        p.Controls.Add(recentList);
    }
    void BuildSend() {
        var p = Page(NiuLanguage.T("发送")); p.Controls.Add(L(NiuLanguage.T("发送 NIU"), 36, 30, 500, 19));
        p.Controls.Add(L(NiuLanguage.T("从我的地址发送"), 36, 88)); sendAccounts.Location = new Point(36,124);sendAccounts.Width=820;sendAccounts.DropDownStyle=ComboBoxStyle.DropDownList;p.Controls.Add(sendAccounts);
        p.Controls.Add(L(NiuLanguage.T("收款钱包地址"),36,176));sendTo.Location=new Point(36,212);sendTo.Width=820;p.Controls.Add(sendTo);
        contactBook.Location=new Point(36,258);contactBook.Width=580;contactBook.DropDownStyle=ComboBoxStyle.DropDownList;p.Controls.Add(contactBook);
        contactBook.SelectedIndexChanged+=delegate{if(contactBook.SelectedIndex>=0&&contactBook.SelectedIndex<contactAddresses.Count)sendTo.Text=contactAddresses[contactBook.SelectedIndex];};
        fill=B(NiuLanguage.T("保存到地址簿"),636,252,async delegate{string label=AskLabel(NiuLanguage.T("联系人备注"));if(label==null)return;await Action(NiuLanguage.T("正在保存联系人…"),async delegate{await Post("contact",new {address=sendTo.Text.Trim(),label=label});Notify(NiuLanguage.T("联系人已保存，可从地址簿选择。"),false);});},220);p.Controls.Add(fill);
        p.Controls.Add(L(NiuLanguage.T("数量（NIU，最多18位小数）"),36,324));amount.Location=new Point(36,360);amount.Width=300;amount.Text="0.1";p.Controls.Add(amount);
        send=B(NiuLanguage.T("签名并发送"),36,422,async delegate{if(!await EnsureUnlocked())return;await Action(NiuLanguage.T("正在发送并等待区块确认…"),async delegate{
            string from=sendAccounts.SelectedIndex>=0&&sendAccounts.SelectedIndex<ownedAddresses.Count?ownedAddresses[sendAccounts.SelectedIndex]:address;
            if(!smoke&&MessageBox.Show(this,NiuLanguage.T("发送地址：")+from+NiuLanguage.T("\n收款地址：")+sendTo.Text.Trim()+NiuLanguage.T("\n数量：")+amount.Text.Trim()+NiuLanguage.T(" NIU\n\n确认后签名并广播，交易还需要支付手续费。"),NiuLanguage.T("确认转账"),MessageBoxButtons.OKCancel,MessageBoxIcon.Question)!=DialogResult.OK)return;
            await Post("transfer",new {to=sendTo.Text.Trim(),amount=amount.Text.Trim(),from=from});Notify(NiuLanguage.T("交易已入块，可在交易记录中查看确认数。"),false);
        });});p.Controls.Add(send);
        p.Controls.Add(L(NiuLanguage.T("从所选地址扣款。各地址余额不能自动合并；地址簿只保存公开地址。"),36,486));
    }
    void BuildReceive() {
        var p = Page(NiuLanguage.T("接收")); p.Controls.Add(L(NiuLanguage.T("接收 NIU"), 36, 30, 500, 19));
        p.Controls.Add(L(NiuLanguage.T("我的收款地址"),36,88));receiveAccounts.Location=new Point(36,124);receiveAccounts.Width=620;receiveAccounts.DropDownStyle=ComboBoxStyle.DropDownList;p.Controls.Add(receiveAccounts);
        receiveAccounts.SelectedIndexChanged+=delegate{UpdateReceiveAddress();};
        p.Controls.Add(B(NiuLanguage.T("新增收款地址"),680,118,async delegate{if(!await EnsureUnlocked())return;string label=AskLabel(NiuLanguage.T("收款地址备注（可留空）"));if(label==null)return;await Action(NiuLanguage.T("正在创建并加密保存地址…"),async delegate{var created=await Post("new-address",new {label=label});accountSignature="";Notify(NiuLanguage.T("新地址已保存。请重新导出备份，旧备份不包含新地址。"),false);});},180));
        receiveAddress=L(NiuLanguage.T("正在读取…"),36,186);receiveAddress.Font=new Font("Consolas",12);p.Controls.Add(receiveAddress);
        p.Controls.Add(B(NiuLanguage.T("复制收款地址"),36,240,delegate{try{if(qrAddress.Length!=42)throw new Exception();Clipboard.SetText(qrAddress);Notify(NiuLanguage.T("收款地址已复制。"),false);}catch{Notify(NiuLanguage.T("地址尚未就绪或复制失败。"),true);}}));
        receiveQr.Location=new Point(36,310);receiveQr.Size=new Size(200,200);receiveQr.SizeMode=PictureBoxSizeMode.Zoom;receiveQr.BackColor=Color.White;p.Controls.Add(receiveQr);
        p.Controls.Add(L(NiuLanguage.T("每个地址由你自己的钱包控制，并有独立的二维码。"),280,328,600));
        var warning=L(NiuLanguage.T("扫描前确认网络。新增地址后，请重新导出完整备份。"),280,380,600);warning.Height=64;p.Controls.Add(warning);
    }
    string AskLabel(string title) {
        using(var dialog=new Form {Text=title,ClientSize=new Size(U(460),U(150)),FormBorderStyle=FormBorderStyle.FixedDialog,StartPosition=FormStartPosition.CenterParent,MinimizeBox=false,MaximizeBox=false,Font=Font}){
            var input=new TextBox {Location=new Point(U(20),U(24)),Width=U(420),MaxLength=40};dialog.Controls.Add(input);
            var ok=new Button {Text=NiuLanguage.T("确定"),Location=new Point(U(240),U(88)),Width=U(95),DialogResult=DialogResult.OK};dialog.Controls.Add(ok);
            var cancel=new Button {Text=NiuLanguage.T("取消"),Location=new Point(U(345),U(88)),Width=U(95),DialogResult=DialogResult.Cancel};dialog.Controls.Add(cancel);
            dialog.AcceptButton=ok;dialog.CancelButton=cancel;return dialog.ShowDialog(this)==DialogResult.OK?input.Text.Trim():null;
        }
    }
    void UpdateReceiveAddress() {
        if(receiveAccounts.SelectedIndex<0||receiveAccounts.SelectedIndex>=ownedAddresses.Count)return;
        string selected=ownedAddresses[receiveAccounts.SelectedIndex];receiveAddress.Text=selected;
        if(qrAddress==selected)return;
        using(var generator=new QRCodeGenerator())using(var data=generator.CreateQrCode(selected,QRCodeGenerator.ECCLevel.Q))using(var code=new QRCode(data)){
            Image old=receiveQr.Image;receiveQr.Image=code.GetGraphic(8);if(old!=null)old.Dispose();qrAddress=selected;
        }
    }
    void BuildTransactions() {
        var p = Page(NiuLanguage.T("交易记录"));
        p.Controls.Add(L(NiuLanguage.T("交易记录"), 36, 26, 500, 19));
        // Direction filter. Everything is local, so switching it must not touch the node.
        var all = new List<Button>();
        string[] captions = { NiuLanguage.T("全部"), NiuLanguage.T("收款记录"), NiuLanguage.T("转出记录") };
        string[] modes = { "all", "in", "out" };
        for (int i = 0; i < modes.Length; i++) {
            string mode = modes[i];
            var filter = new Button { Text = captions[i], Location = new Point(36 + i * 132, 66), Size = new Size(122, 34), FlatStyle = FlatStyle.Flat, UseVisualStyleBackColor = false, TabStop = false };
            filter.FlatAppearance.BorderColor = Color.FromArgb(206, 200, 180); filter.FlatAppearance.BorderSize = 1;
            filter.Click += delegate { txFilter = mode; foreach (Button other in all) { bool active = other == filter; other.BackColor = active ? Color.FromArgb(216, 226, 207) : Color.White; other.Font = new Font(Font.FontFamily, 10, active ? FontStyle.Bold : FontStyle.Regular); } Render(); };
            all.Add(filter); p.Controls.Add(filter);
            if (mode == txFilter) { filter.BackColor = Color.FromArgb(216, 226, 207); filter.Font = new Font(Font.FontFamily, 10, FontStyle.Bold); } else filter.BackColor = Color.White;
        }
        transactions.Location = new Point(36, 116); transactions.Size = new Size(878, 244);
        transactions.View = View.Details; transactions.FullRowSelect = true; transactions.GridLines = false; transactions.HideSelection = false; transactions.MultiSelect = false;
        transactions.Columns.Add(NiuLanguage.T("操作"), 84);
        transactions.Columns.Add(NiuLanguage.T("金额"), 150);
        transactions.Columns.Add(NiuLanguage.T("对方"), 300);
        transactions.Columns.Add(NiuLanguage.T("确认数"), 84);
        transactions.Columns.Add(NiuLanguage.T("时间"), 132);
        transactions.Columns.Add(NiuLanguage.T("交易哈希"), 128);
        transactions.SelectedIndexChanged += delegate { ShowTransactionDetail(); };
        p.Controls.Add(transactions);
        var detail = new Panel { Location = new Point(36, 374), Size = new Size(878, 222), BackColor = Color.White, BorderStyle = BorderStyle.FixedSingle };
        detail.Controls.Add(new Label { Text = NiuLanguage.T("交易详情"), Location = new Point(14, 8), Size = new Size(400, 28), Font = new Font(Font.FontFamily, 11, FontStyle.Bold), ForeColor = Color.FromArgb(33,77,60) });
        txDetailHash = new Label { Text = NiuLanguage.T("请选择一笔交易"), Location = new Point(14, 40), Size = new Size(690, 28), Font = new Font("Consolas", 11), ForeColor = Color.FromArgb(123,115,91) };
        txDetailMeta = new Label { Text = "", Location = new Point(14, 74), Size = new Size(848, 140), Font = new Font("Consolas", 9) };
        var copyHash = new Button { Text = NiuLanguage.T("复制哈希"), Location = new Point(720, 38), Size = new Size(142, 32), FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(33,77,60), ForeColor = Color.FromArgb(250,246,231), UseVisualStyleBackColor = false };
        copyHash.FlatAppearance.BorderSize = 0;
        copyHash.Click += delegate {
            try { if (selectedHash == null || selectedHash.Length != 66) throw new Exception(); Clipboard.SetText(selectedHash); Notify(NiuLanguage.T("哈希已复制。"), false); }
            catch { Notify(NiuLanguage.T("请选择一笔交易"), true); }
        };
        detail.Controls.Add(txDetailHash); detail.Controls.Add(txDetailMeta); detail.Controls.Add(copyHash);
        p.Controls.Add(detail);
    }
    void BuildSettings() {
        var p = Page(NiuLanguage.T("设置"));
        // Each row advances by its measured height, so longer translations or
        // larger fonts push the layout down instead of overlapping the next row.
        // 左栏：备份与安全
        int y = 24;
        var heading = L(NiuLanguage.T("加密钱包备份"), 24, y, 500, 17); p.Controls.Add(heading); y += heading.Height + 10;
        foreach (string line in new string[] {
                NiuLanguage.T("本机密钥由 Windows 账户保护；导出的备份使用你设置的独立密码加密。"),
                NiuLanguage.T("私钥仅在解锁时载入内存；空闲约5分钟会自动上锁。"),
                NiuLanguage.T("备份可用于换电脑或重装系统。文件和密码缺一不可，项目方无法找回密码。") }) {
            var item = L(line, 24, y, 470, 9); p.Controls.Add(item); y += item.Height + 6;
        }
        y += 8;
        backup = B(NiuLanguage.T("保存加密备份"), 24, y, async delegate {
            if (!smoke && !await EnsureUnlocked()) return;
            string password = smoke ? "QA-only-" + Guid.NewGuid().ToString() : AskPassword(true);
            if (password == null) return;
            await Action(NiuLanguage.T("正在加密并校验备份…"), async delegate { var v = await Post("backup-portable", new { password = password }); backupPath.Text = S(v, "path"); Notify(NiuLanguage.T("备份已加密并通过回读校验。请将文件和密码分开保管。"), false); });
            password = null;
        }, 185); p.Controls.Add(backup);
        p.Controls.Add(B(NiuLanguage.T("立即上锁"), backup.Right + 21, y, async delegate { await Post("lock", new { }); LockWallet(); accountSignature = ""; Notify(NiuLanguage.T("钱包已上锁，私钥已从内存清除。"), false); }, 150));
        y += 42 + 14;
        backupPath.Location = new Point(24, y); backupPath.Size = new Size(470, 56); backupPath.Multiline = true; backupPath.ReadOnly = true; p.Controls.Add(backupPath);
        y += 56 + 12;
        backupWarning=L("",24,y,470,9);backupWarning.Height=48;backupWarning.ForeColor=Color.FromArgb(149,92,31);p.Controls.Add(backupWarning);
        y += 48 + 10;
        var importButton = B(NiuLanguage.T("导入钱包备份"), 24, y, async delegate {
            if (!await EnsureUnlocked()) return;
            using (var picker = new OpenFileDialog { Filter = NiuLanguage.T("钱包或备份文件 (*.json;*.dat;*.dpapi)|*.json;*.dat;*.dpapi"), CheckFileExists = true, Title = NiuLanguage.T("导入钱包备份") }) {
                if (picker.ShowDialog(this) != DialogResult.OK) return;
                bool portable = picker.FileName.ToLowerInvariant().EndsWith(".json");
                string password = portable ? AskPassword(false) : "";
                if (password == null) return;
                await Action(NiuLanguage.T("正在导入钱包备份…"), async delegate {
                    var v = await Post("import-wallet", new { path = picker.FileName, password = password });
                    int added, total; int.TryParse(S(v,"added"), out added); int.TryParse(S(v,"total"), out total);
                    Notify(added > 0
                        ? NiuLanguage.T("导入完成：新增 {0} 个地址，当前共 {1} 个地址。").Replace("{0}", added.ToString()).Replace("{1}", total.ToString())
                        : NiuLanguage.T("备份中的地址均已存在于当前钱包，未新增。"), false);
                });
            }
        }, 185); p.Controls.Add(importButton); y += 42 + 14;
        var restore = L(NiuLanguage.T("恢复：在新解压的钱包首次启动时选择“恢复备份”。不覆盖已有钱包。"), 24, y, 470, 9); p.Controls.Add(restore); y += restore.Height + 18;
        var aboutHeading = L(NiuLanguage.T("关于与网络"), 24, y, 470, 12); p.Controls.Add(aboutHeading); y += aboutHeading.Height + 6;
        p.Controls.Add(L(NiuLanguage.T("本地开发网络：发行规则和朋友之间联网尚未完成，当前余额不承诺迁移。\nCore-Geth v1.12.23 · London EVM · 未签名，未独立审计。"), 24, y, 470, 9));
        // 右栏：链上留言与界面语言
        int ry = 24;
        var guestHeading = L(NiuLanguage.T("链上留言"), 560, ry, 400, 17); p.Controls.Add(guestHeading); ry += guestHeading.Height + 10;
        var guestHint = L(NiuLanguage.T("输入留言；部署与修改需要开启挖矿，并消耗测试NIU手续费。"), 560, ry, 390, 9); p.Controls.Add(guestHint); ry += guestHint.Height + 8;
        message.Location = new Point(560, ry); message.Size = new Size(390, 70); message.Multiline = true; message.MaxLength = 160; message.Text = NiuLanguage.T("慢慢来，也很牛。"); p.Controls.Add(message);
        ry += 70 + 14;
        deploy = B(NiuLanguage.T("部署留言合约"), 560, ry, async delegate { if(!await EnsureUnlocked())return; await Action(NiuLanguage.T("正在部署合约并等待确认…"), async delegate { await Post("deploy", new { message = message.Text }); Notify(NiuLanguage.T("合约部署已确认。"), false); }); }, 185);
        update = B(NiuLanguage.T("更新链上留言"), deploy.Right + 20, ry, async delegate { if(!await EnsureUnlocked())return; await Action(NiuLanguage.T("正在修改留言并等待确认…"), async delegate { await Post("message", new { message = message.Text }); Notify(NiuLanguage.T("链上留言已更新。"), false); }); }, 175);
        p.Controls.Add(deploy); p.Controls.Add(update);
        ry += 42 + 14;
        var currentHeading = L(NiuLanguage.T("当前链上留言"), 560, ry, 400, 9); p.Controls.Add(currentHeading); ry += currentHeading.Height + 6;
        currentMessage = L(NiuLanguage.T("尚未部署"), 560, ry, 390, 12); currentMessage.Height = 56; p.Controls.Add(currentMessage);
        ry += 56 + 8;
        contractAddress = L("", 560, ry, 390, 10); contractAddress.Font = new Font("Consolas", 9); p.Controls.Add(contractAddress);
        ry += 34 + 14;
        var languageHeading = L(NiuLanguage.T("界面语言"),560,ry,400,12); p.Controls.Add(languageHeading); ry += languageHeading.Height + 6;
        languageChoice.Location=new Point(560,ry);languageChoice.Width=390;
        languageChoice.Height=34;languageChoice.BackColor=Color.White;languageChoice.ForeColor=Color.FromArgb(33,77,60);languageChoice.TextAlign=ContentAlignment.MiddleLeft;
        foreach(string code in NiuLanguage.Codes) {
            var item=new ToolStripMenuItem(NiuLanguage.Names[Array.IndexOf(NiuLanguage.Codes,code)]);item.Tag=code;
            item.Click+=delegate(object sender,EventArgs e) {
                string next=(string)((ToolStripMenuItem)sender).Tag;
                try {NiuLanguage.Save(next);NiuLanguage.Current=next;ApplyLanguage();}
                catch {MessageBox.Show(this,NiuLanguage.T("语言设置保存失败，请检查当前用户的应用数据目录权限。"),"NIU Wallet");}
            };languageMenu.Items.Add(item);
        }
        languageChoice.Click+=delegate {languageMenu.Show(languageChoice,new Point(0,languageChoice.Height));};
        p.Controls.Add(languageChoice);
        ry += 34 + 12;
        p.Controls.Add(L(NiuLanguage.T("切换立即生效，重启后保留；不改变地址、余额或链上留言。"),560,ry,390,9));
    }
    // The vault holds private keys only while unlocked. Any signing action asks
    // for the wallet password first, so an unattended window cannot spend.
    bool walletUnlocked;
    async Task<bool> EnsureUnlocked() {
        if (walletUnlocked) return true;
        if (smoke) { await Post("unlock", new { password = "QA-only-" + Guid.NewGuid().ToString() }); walletUnlocked = true; return true; }
        string value = AskWalletPassword();
        if (value == null) return false;
        try {
            await Action(NiuLanguage.T("正在解锁钱包…"), async delegate {
                await Post("unlock", new { password = value });
                walletUnlocked = true;
            });
            Notify(NiuLanguage.T("钱包已解锁，请保管好当前窗口。"), false);
            return true;
        } catch { return false; }
        finally { value = null; }
    }
    void LockWallet() { walletUnlocked = false; }
    string AskWalletPassword() {
        using (var dialog = new Form { Text = NiuLanguage.T("解锁钱包"), ClientSize = new Size(U(470), U(190)), FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterParent, MinimizeBox = false, MaximizeBox = false, Font = Font }) {
            dialog.Controls.Add(new Label { Text = NiuLanguage.T("私钥已加密，需要口令才能签名和转账。"), AutoSize = true, Location = new Point(U(20),U(20)) });
            var password = new TextBox { Location = new Point(U(20),U(58)), Width = U(425), UseSystemPasswordChar = true, MaxLength = 256 }; dialog.Controls.Add(password);
            var ok = new Button { Text = NiuLanguage.T("解锁"), Location = new Point(U(245),U(130)), Width = U(95) }; dialog.Controls.Add(ok);
            var cancel = new Button { Text = NiuLanguage.T("取消"), DialogResult = DialogResult.Cancel, Location = new Point(U(350),U(130)), Width = U(95) }; dialog.Controls.Add(cancel);
            ok.Click += delegate { if (password.Text.Length < 12) { MessageBox.Show(dialog,NiuLanguage.T("口令至少12个字符。"),NiuLanguage.T("请检查口令")); return; } dialog.DialogResult = DialogResult.OK; };
            dialog.AcceptButton = ok; dialog.CancelButton = cancel;
            if (dialog.ShowDialog(this) != DialogResult.OK) return null;
            string value = password.Text; password.Clear(); return value;
        }
    }
    string AskPassword(bool confirm) {
        using (var dialog = new Form { Text = confirm ? NiuLanguage.T("设置备份密码") : NiuLanguage.T("输入备份密码"), ClientSize = new Size(U(470), U(240)), FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterParent, MinimizeBox = false, MaximizeBox = false, Font = Font }) {
            dialog.Controls.Add(new Label { Text = NiuLanguage.T("至少12个字符。请妥善保存，丢失后无法恢复。"), AutoSize = true, Location = new Point(U(20),U(20)) });
            var password = new TextBox { Location = new Point(U(20),U(60)), Width = U(425), UseSystemPasswordChar = true, MaxLength = 256 }; dialog.Controls.Add(password);
            var repeated = new TextBox { Location = new Point(U(20),U(120)), Width = U(425), UseSystemPasswordChar = true, MaxLength = 256, Visible = confirm }; dialog.Controls.Add(repeated);
            if (confirm) dialog.Controls.Add(new Label { Text = NiuLanguage.T("再次输入密码"), AutoSize = true, Location = new Point(U(20),U(96)) });
            var ok = new Button { Text = NiuLanguage.T("确定"), Location = new Point(U(245),U(180)), Width = U(95) }; dialog.Controls.Add(ok);
            var cancel = new Button { Text = NiuLanguage.T("取消"), DialogResult = DialogResult.Cancel, Location = new Point(U(350),U(180)), Width = U(95) }; dialog.Controls.Add(cancel);
            ok.Click += delegate { if (password.Text.Length < 12 || (confirm && password.Text != repeated.Text)) { MessageBox.Show(dialog,NiuLanguage.T("密码至少12个字符，且两次输入必须一致。"),NiuLanguage.T("请检查密码")); return; } dialog.DialogResult = DialogResult.OK; };
            dialog.AcceptButton = ok; dialog.CancelButton = cancel;
            if (dialog.ShowDialog(this) != DialogResult.OK) return null;
            string value = password.Text; password.Clear(); repeated.Clear(); return value;
        }
    }
    async Task RestoreBeforeStart() {
        if (smoke || File.Exists(Path.Combine(root,"runtime","persistent","wallet.dpapi"))) return;
        var choice = MessageBox.Show(this,NiuLanguage.T("创建新的钱包吗？\n\n是：创建新钱包\n否：从加密备份恢复\n取消：暂不启动"), NiuLanguage.T("欢迎使用牛币钱包"), MessageBoxButtons.YesNoCancel);
        if (choice == DialogResult.Cancel) throw new Exception(NiuLanguage.T("已取消钱包初始化。"));
        if (choice == DialogResult.Yes) return;
        using (var picker = new OpenFileDialog { Filter = NiuLanguage.T("牛币加密备份 (*.json)|*.json"), CheckFileExists = true }) {
            if (picker.ShowDialog(this) != DialogResult.OK) throw new Exception(NiuLanguage.T("已取消备份恢复。"));
            string password = AskPassword(false); if (password == null) throw new Exception(NiuLanguage.T("已取消备份恢复。"));
            var payload = serializer.Serialize(new { path = picker.FileName, password = password });
            await Task.Run(delegate {
                using (var process = new Process { StartInfo = new ProcessStartInfo(Path.Combine(root,"engine","node.exe"),"scripts/restore-wallet.mjs") { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 } }) {
                    process.Start(); byte[] input = Encoding.UTF8.GetBytes(payload); process.StandardInput.BaseStream.Write(input,0,input.Length); process.StandardInput.Close(); Array.Clear(input,0,input.Length);
                    var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(90000)) { process.Kill(); throw new Exception(NiuLanguage.T("恢复超时，请检查备份文件。原钱包未覆盖。")); }
                    Task.WaitAll(output,error); if (process.ExitCode != 0) throw new Exception(error.Result.Trim());
                }
            });
            password = null; payload = null;
        }
    }
    string S(Dictionary<string, object> d, string key) { return d.ContainsKey(key) && d[key] != null ? Convert.ToString(d[key]) : ""; }
    Dictionary<string, object> D(object v) { return (Dictionary<string, object>)v; }
    object[] A(object v) { return (object[])v; }
    async Task<string> Request(string path, object payload = null) {
        return await Task.Run(delegate {
            var req = (HttpWebRequest)WebRequest.Create(endpoint + path); req.Timeout = payload == null ? 12000 : 300000; req.ReadWriteTimeout = req.Timeout; req.Proxy = null;
            if (payload != null) { req.Method = "POST"; req.ContentType = "application/json"; req.Headers["Origin"] = endpoint; req.Headers["X-Niu-Token"] = token;
                byte[] bytes = Encoding.UTF8.GetBytes(serializer.Serialize(payload)); req.ContentLength = bytes.Length; using (var stream = req.GetRequestStream()) stream.Write(bytes, 0, bytes.Length); }
            try { using (var response = req.GetResponse()) using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) return reader.ReadToEnd(); }
            catch (WebException e) { if (e.Response != null) { using (var reader = new StreamReader(e.Response.GetResponseStream(), Encoding.UTF8)) { var error = serializer.DeserializeObject(reader.ReadToEnd()) as Dictionary<string, object>; if (error != null && error.ContainsKey("error")) throw new Exception(Convert.ToString(error["error"])); } } throw; }
        });
    }
    async Task<Dictionary<string, object>> Post(string path, object value) { return D(serializer.DeserializeObject(await Request("/api/" + path, value))); }
    async Task StartWallet() {
        try {
            if (!File.Exists(Path.Combine(root, "engine", "node.exe"))) throw new Exception(NiuLanguage.T("请完整解压Windows钱包下载包后启动，缺少engine/node.exe。"));
            bool occupied = false; try { await Request("/api/state"); occupied = true; } catch { }
            if (occupied) throw new Exception(NiuLanguage.T("本机已有钱包服务占用18790端口，请先关闭已有钱包。不会切换到另一个目录的钱包。"));
            await RestoreBeforeStart();
            Directory.CreateDirectory(Path.Combine(root, "runtime"));
            outputLog = new StreamWriter(Path.Combine(root, "runtime", "desktop-console.log"), true, Encoding.UTF8) { AutoFlush = true };
            errorLog = new StreamWriter(Path.Combine(root, "runtime", "desktop-error.log"), true, Encoding.UTF8) { AutoFlush = true };
            backend = new Process(); backend.StartInfo = new ProcessStartInfo(Path.Combine(root, "engine", "node.exe"), "scripts/server.mjs") { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
            backend.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) { lock (outputLog) { if (!closing) outputLog.WriteLine(e.Data); } } };
            backend.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) { lock (errorLog) { if (!closing) errorLog.WriteLine(e.Data); } } };
            backend.Start(); backend.BeginOutputReadLine(); backend.BeginErrorReadLine();
            DateTime limit = DateTime.UtcNow.AddSeconds(90);
            while (DateTime.UtcNow < limit) {
                if (backend.HasExited) throw new Exception(NiuLanguage.T("后台节点已退出，请检查runtime/desktop-error.log。"));
                Dictionary<string, object> v = null;
                try { v = D(serializer.DeserializeObject(await Request("/api/state"))); } catch { }
                if (v != null && v.ContainsKey("chainId")) {
                    string expected = Path.GetFullPath(Path.Combine(root, "runtime", "persistent")).TrimEnd('\\');
                    if (!String.Equals(Path.GetFullPath(S(v, "dataPath")).TrimEnd('\\'), expected, StringComparison.OrdinalIgnoreCase)) throw new Exception(NiuLanguage.T("节点数据目录不匹配，拒绝连接。"));
                    state = v; break;
                }
                await Task.Delay(1000);
            }
            if (state == null) throw new Exception(NiuLanguage.T("节点启动超时，请检查日志；不要删除钱包文件。"));
            token = Regex.Match(await Request("/"), "name=\"niu-token\" content=\"([^\"]+)\"").Groups[1].Value;
            if (token.Length == 0) throw new Exception(NiuLanguage.T("钱包本机会话初始化失败。"));
            ready = true; Render(); SetEnabled(); poll.Start(); Notify(NiuLanguage.T("钱包节点已就绪，挖矿默认关闭。请查看节点连接与同步状态。"), false);
            if (closeAfterReady) { await CloseWallet(); return; }
            if (smoke) await SmokeTest();
        } catch (Exception e) { Notify(e.Message, true); if (smoke) SaveSmoke(false, e.Message); }
        finally { starting = false; }
        if (!closing && !ready && backend != null && !backend.HasExited && String.IsNullOrEmpty(token)) {
            try { token = Regex.Match(await Request("/"), "name=\"niu-token\" content=\"([^\"]+)\"").Groups[1].Value; } catch { }
        }
        if (smoke && !closing) await CloseWallet();
    }
    async Task RefreshState() {
        if (!ready || refreshing || closing) return; refreshing = true;
        try { state = D(serializer.DeserializeObject(await Request("/api/state"))); Render(); } catch (Exception e) { Notify(NiuLanguage.T("读取节点失败：") + e.Message, true); }
        finally { refreshing = false; }
    }
    void Render() {
        var wallets = A(state["wallets"]); var w = D(wallets[0]); address = S(w, "address"); recipient = S(D(wallets[1]), "address");
        // Mirror the backend vault state so the button and prompts agree with
        // what actually holds keys in memory right now.
        walletUnlocked = !state.ContainsKey("locked") || !Convert.ToBoolean(state["locked"]);
        string total=state.ContainsKey("walletTotal")?S(state,"walletTotal"):S(w,"balance");
        decimal value; string text = Decimal.TryParse(total, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out value) ? value.ToString("0.########") : total;
        balance.Text = text + "  NIU"; overviewAddress.Text = address;
        string signature="";foreach(object item in wallets){var itemWallet=D(item);signature+=S(itemWallet,"address")+S(itemWallet,"name");}
        if(signature!=accountSignature){
            string oldReceive=qrAddress;ownedAddresses.Clear();receiveAccounts.Items.Clear();sendAccounts.Items.Clear();
            foreach(object item in wallets){var itemWallet=D(item);string itemAddress=S(itemWallet,"address"),label=S(itemWallet,"name")+"  |  "+itemAddress;ownedAddresses.Add(itemAddress);receiveAccounts.Items.Add(label);sendAccounts.Items.Add(label);}
            int selected=ownedAddresses.IndexOf(S(state,"activeReceivingAddress"));if(selected<0)selected=ownedAddresses.IndexOf(oldReceive);
            receiveAccounts.SelectedIndex=selected<0?0:selected;sendAccounts.SelectedIndex=0;accountSignature=signature;
        }
        UpdateReceiveAddress();
        backupWarning.Text=state.ContainsKey("backupRequired")&&Convert.ToBoolean(state["backupRequired"])?NiuLanguage.T("尚有地址未包含在当前备份中，请重新保存完整加密备份。"):NiuLanguage.T("当前所有地址已包含在最近导出的备份中。");
        if(state.ContainsKey("contacts")){string contactsKey=serializer.Serialize(state["contacts"]);if(contactsKey!=contactSignature){contactBook.Items.Clear();contactAddresses.Clear();foreach(object item in A(state["contacts"])){var contact=D(item);contactAddresses.Add(S(contact,"address"));contactBook.Items.Add(S(contact,"label")+"  |  "+S(contact,"address"));}contactSignature=contactsKey;}}
        var heights = A(state["heights"]); height.Text = NiuLanguage.T("区块高度  ") + heights[0];
        if (heights.Length > 1) height.Text += NiuLanguage.T("       验证节点高度  ") + heights[1];
        var sync = state.ContainsKey("syncing") ? state["syncing"] as Dictionary<string,object> : null;
        if (sync != null) height.Text += NiuLanguage.T("       同步中  ") + S(sync,"currentBlock") + " / " + S(sync,"highestBlock");
        peerState.Text = NiuLanguage.T("节点连接  ") + state["peers"] + (S(state,"connectionStatus") == "disconnected" ? NiuLanguage.T(" · 未联网") : sync != null ? NiuLanguage.T(" · 正在同步") : NiuLanguage.T(" · 已连接"));
        // Footer signal indicator mirrors the connection state at a glance.
        string connectionStatus = S(state,"connectionStatus");
        if (connectionStatus == "disconnected") {
            netSignal.Level = 0; netSignal.Good = false;
            netState.Text = NiuLanguage.T("未连接"); netState.ForeColor = Color.FromArgb(150,62,40);
        } else if (sync != null) {
            netSignal.Good = false;
            netState.Text = NiuLanguage.T("正在同步"); netState.ForeColor = Color.FromArgb(149,92,31);
            long current = ParseHexOrDec(S(sync,"currentBlock")), highest = ParseHexOrDec(S(sync,"highestBlock"));
            netSignal.Level = highest > 0 ? (int)Math.Max(1, Math.Min(3, 4L * current / highest)) : 2;
        } else {
            netSignal.Level = 4; netSignal.Good = true;
            netState.Text = NiuLanguage.T("已连接"); netState.ForeColor = Color.FromArgb(33,77,60);
        }
        netSignal.Invalidate();
        // Tell the user plainly when a killed node rolled the head back and what
        // the launcher did about it; never let a shorter chain look normal.
        if (!chainNotified) {
            var recovered = state.ContainsKey("chainRecovered") ? state["chainRecovered"] as Dictionary<string,object> : null;
            var reset = state.ContainsKey("chainReset") ? state["chainReset"] as Dictionary<string,object> : null;
            if (recovered != null) {
                chainNotified = true;
                Notify(NiuLanguage.T("检测到链头回退：已自动恢复到区块 {0}（此前链头在区块 {1}）。").Replace("{0}", S(recovered,"to")).Replace("{1}", S(recovered,"from")), false);
            } else if (reset != null) {
                chainNotified = true;
                string warning = NiuLanguage.T("警告：链头回退到区块 {0}，且回退部分的状态数据已缺失，无法自动恢复。请保持钱包正常关闭（不要结束进程）；新挖矿将从当前链继续。").Replace("{0}", S(reset,"head"));
                status.Text = warning; Notify(warning, true);
            }
        }
        bool active = Convert.ToBoolean(state["mining"]); minerState.Text = NiuLanguage.T("挖矿状态：") + (active ? NiuLanguage.T("挖矿中（最多十分钟）") : NiuLanguage.T("已停止")); mine.Text = active ? NiuLanguage.T("停止挖矿") : NiuLanguage.T("开启挖矿");
        // Ledger rows: colour by direction, keep the selection across refreshes,
        // and notice a confirmed payment that was not in the previous refresh.
        object[] ledger = A(state["transactions"]); if (ledger == null) ledger = new object[0];
        Dictionary<string, object> arrived = null;
        transactions.BeginUpdate(); transactions.Items.Clear();
        foreach (object item in ledger) {
            var tx = D(item);
            string txHash = S(tx, "hash"), dir = S(tx, "dir"), txStatus = S(tx, "status");
            if (dir == "in" && txStatus == "confirmed") {
                if (incomingPrimed && arrived == null && !notifiedIncoming.Contains(txHash)) arrived = tx;
                notifiedIncoming.Add(txHash);
            }
            if (txFilter != "all" && dir != txFilter) continue;
            var row = new ListViewItem(NiuLanguage.T(S(tx, "kind")));
            row.SubItems.Add(S(tx, "amount").Length > 0 ? (dir == "in" ? "+" : "-") + S(tx, "amount") + " NIU" : "—");
            string party = dir == "in" ? S(tx, "from") : S(tx, "to");
            row.SubItems.Add(party.Length > 0 ? party : "—");
            row.SubItems.Add(txStatus == "confirmed" ? S(tx, "confirmations") : "—");
            row.SubItems.Add(LocalTime(S(tx, "at"), false));
            row.SubItems.Add(ShortHash(txHash));
            row.Tag = txHash;
            row.ForeColor = dir == "in" ? Color.FromArgb(33, 77, 60) : Color.FromArgb(150, 62, 40);
            transactions.Items.Add(row);
            if (txHash == selectedHash) row.Selected = true;
        }
        incomingPrimed = true;
        transactions.EndUpdate();
        ShowTransactionDetail();
        var recent = new List<string>();
        foreach (object item in ledger) {
            if (recent.Count >= 3) break;
            var tx = D(item); string dir = S(tx, "dir");
            recent.Add((dir == "in" ? "+" : "-") + S(tx, "amount") + " NIU   " + (dir == "in" ? NiuLanguage.T("收款") : NiuLanguage.T("转出")) + "   " + ShortHash(S(tx, "hash")) + "   " + LocalTime(S(tx, "at"), false));
        }
        recentList.Text = recent.Count == 0 ? NiuLanguage.T("暂无记录") : String.Join("\n", recent.ToArray());
        if (incomingBanner.Visible && DateTime.UtcNow > incomingBannerUntil) incomingBanner.Visible = false;
        var c = state["contract"] as Dictionary<string, object>; currentMessage.Text = c == null ? NiuLanguage.T("尚未部署") : c.ContainsKey("pending") ? NiuLanguage.T("部署等待确认…") : S(c, "message"); contractAddress.Text = c == null ? "" : S(c, "address");
        if (arrived != null) AnnounceIncoming(arrived);
        SetEnabled();
    }

    string ShortHash(string hash) {
        if (String.IsNullOrEmpty(hash)) return "—";
        return hash.Length > 20 ? hash.Substring(0, 10) + "…" + hash.Substring(hash.Length - 6) : hash;
    }
    // geth reports counters either as decimal strings or 0x-hex; accept both.
    long ParseHexOrDec(string text) {
        if (String.IsNullOrEmpty(text)) return 0;
        if (text.StartsWith("0x") || text.StartsWith("0X")) { long v; return long.TryParse(text.Substring(2), System.Globalization.NumberStyles.HexNumber, null, out v) ? v : 0; }
        long d; return long.TryParse(text, out d) ? d : 0;
    }
    string LocalTime(string iso, bool full) {
        DateTime parsed;
        if (!String.IsNullOrEmpty(iso) && DateTime.TryParse(iso, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out parsed))
            return parsed.ToLocalTime().ToString(full ? "yyyy-MM-dd HH:mm:ss" : "MM-dd HH:mm");
        return String.IsNullOrEmpty(iso) ? "—" : iso;
    }
    Dictionary<string, object> FindTransaction(string hash) {
        if (state == null || String.IsNullOrEmpty(hash)) return null;
        object[] ledger = A(state["transactions"]); if (ledger == null) return null;
        foreach (object item in ledger) { var tx = D(item); if (S(tx, "hash") == hash) return tx; }
        return null;
    }
    // The detail panel is the point of the history page: the full 66-character hash,
    // the block it landed in and the local time, selectable and copyable.
    void ShowTransactionDetail() {
        if (transactions.SelectedItems.Count == 0) {
            selectedHash = "";
            txDetailHash.Text = NiuLanguage.T("请选择一笔交易"); txDetailHash.ForeColor = Color.FromArgb(123, 115, 91);
            txDetailMeta.Text = "";
            return;
        }
        var row = transactions.SelectedItems[0];
        selectedHash = Convert.ToString(row.Tag);
        txDetailHash.Text = selectedHash; txDetailHash.ForeColor = Color.FromArgb(33, 77, 60);
        var tx = FindTransaction(selectedHash);
        if (tx == null) { txDetailMeta.Text = ""; return; }
        string dir = S(tx, "dir"), st = S(tx, "status");
        string statusText = st == "confirmed" ? NiuLanguage.T("已入块 ") + S(tx, "confirmations") : st == "failed" ? NiuLanguage.T("执行失败") : st == "reorged" ? NiuLanguage.T("链重组待确认") : NiuLanguage.T("等待确认");
        string blockHash = S(tx, "blockHash"); if (blockHash.Length == 0) blockHash = "—";
        string[] lines = {
            NiuLanguage.T("金额") + "      " + (dir == "in" ? "+" : "-") + S(tx, "amount") + " NIU",
            (dir == "in" ? NiuLanguage.T("来自") : NiuLanguage.T("转给")) + "      " + (dir == "in" ? S(tx, "from") : S(tx, "to")),
            NiuLanguage.T("状态") + "      " + statusText,
            NiuLanguage.T("本地时间") + "    " + LocalTime(S(tx, "at"), true),
            NiuLanguage.T("区块哈希") + "    " + blockHash,
            NiuLanguage.T("完整交易哈希") + "  " + selectedHash
        };
        txDetailMeta.Text = String.Join("\n", lines);
    }
    // A payment this wallet has not announced before: in-window banner, status line,
    // and a tray balloon when the window is not already in front of the user.
    void AnnounceIncoming(Dictionary<string, object> tx) {
        string summary = NiuLanguage.T("收到") + " " + S(tx, "amount") + " NIU   " + NiuLanguage.T("来自") + " " + ShortHash(S(tx, "from")) + "   " + NiuLanguage.T("确认数") + " " + S(tx, "confirmations");
        incomingText.Text = NiuLanguage.T("新到账") + "  ·  " + summary;
        incomingBanner.Visible = true;
        incomingBannerUntil = DateTime.UtcNow.AddMinutes(2);
        Notify(summary, false);
        try { if (!ContainsFocus && tray.Visible) { tray.BalloonTipTitle = NiuLanguage.T("新到账"); tray.BalloonTipText = summary; tray.BalloonTipIcon = ToolTipIcon.Info; tray.ShowBalloonTip(8000); } } catch { }
        try { System.Media.SystemSounds.Asterisk.Play(); } catch { }
    }

    bool IsLiveText(Control c) {
        return c==status||c==balance||c==height||c==minerState||c==peerState||c==overviewAddress||c==receiveAddress||c==contractAddress||c==currentMessage||c==backupWarning||c==mine
            ||c==incomingText||c==recentList||c==txDetailHash||c==txDetailMeta;
    }
    void CaptureLanguageText(Control c) {
        if(!(c is TextBox)&&!(c is ComboBox)&&!IsLiveText(c)) {
            string key=NiuLanguage.Key(c.Text);if(key!=null)languageText[c]=key;
        }
        foreach(Control child in c.Controls)CaptureLanguageText(child);
        if(c==this)foreach(ColumnHeader column in transactions.Columns)columnText.Add(NiuLanguage.Key(column.Text)??column.Text);
    }
    void ApplyLanguage() {
        SuspendLayout();
        foreach(var entry in languageText)entry.Key.Text=NiuLanguage.T(entry.Value);
        for(int i=0;i<columnText.Count;i++)transactions.Columns[i].Text=NiuLanguage.T(columnText[i]);
        string statusKey=NiuLanguage.Key(status.Text);if(statusKey!=null)status.Text=NiuLanguage.T(statusKey);
        languageChoice.Text=NiuLanguage.Names[Array.IndexOf(NiuLanguage.Codes,NiuLanguage.Current)]+"  ▼";
        foreach(ToolStripMenuItem item in languageMenu.Items)item.Checked=(string)item.Tag==NiuLanguage.Current;
        if(ready&&state!=null)Render();else {
            foreach(var live in new Label[]{overviewAddress,receiveAddress,balance,height,peerState,minerState,backupWarning,currentMessage,netState}) {
                string key=NiuLanguage.Key(live.Text);if(key!=null)live.Text=NiuLanguage.T(key);
            }
            mine.Text=NiuLanguage.T("开启挖矿");
        }
        ResumeLayout(true);Invalidate(true);
    }
    async Task LanguageSmokeTest() {
        string previous=NiuLanguage.Current;
        string directory=Path.Combine(root,"runtime","language-qa");Directory.CreateDirectory(directory);
        try {
            sendTo.Text="0x1111111111111111111111111111111111111111";amount.Text="12.34567890123456789";message.Text="User message 中文 日本語 한국어";
            currentMessage.Text="On-chain message 中文";
            var checks=new List<object>();
            foreach(string code in NiuLanguage.Codes) {
                ((ToolStripMenuItem)languageMenu.Items[Array.IndexOf(NiuLanguage.Codes,code)]).PerformClick();
                if(NiuLanguage.Current!=code||NiuLanguage.ReadPreference()!=code||!languageChoice.Text.StartsWith(NiuLanguage.Names[Array.IndexOf(NiuLanguage.Codes,code)]))throw new Exception("Language selection or persistence failed: "+code);
                if(sendTo.Text!="0x1111111111111111111111111111111111111111"||amount.Text!="12.34567890123456789"||message.Text!="User message 中文 日本語 한국어"||currentMessage.Text!="On-chain message 中文")throw new Exception("Language switch changed user data");
                for(int page=0;page<pages.Count;page++) {
                    SelectPage(page);await Task.Delay(30);
                    using(var image=new Bitmap(Width,Height)){DrawToBitmap(image,new Rectangle(0,0,Width,Height));image.Save(Path.Combine(directory,code+"-"+page+".png"));}
                }
                checks.Add(new {language=code,pages=pages.Count,persistence=true,userInputPreserved=true});
            }
            File.WriteAllText(Path.Combine(directory,"report.json"),serializer.Serialize(new {status="passed",checks=checks,backendStarted=false,at=DateTime.UtcNow.ToString("o")}),Encoding.UTF8);
        } catch(Exception e) {File.WriteAllText(Path.Combine(directory,"report.json"),serializer.Serialize(new {status="failed",error=e.Message}),Encoding.UTF8);}
        finally {NiuLanguage.Current=previous;NiuLanguage.Save(previous);closing=true;Close();}
    }

    void SetEnabled() {
        languageChoice.Enabled = !actionBusy && !closing;
        foreach (var b in buttons) b.Enabled = ready && !actionBusy && !closing;
        if (ready && state != null) { deploy.Enabled = !actionBusy && !closing && state["contract"] == null; var c = state["contract"] as Dictionary<string, object>; update.Enabled = !actionBusy && !closing && c != null && !c.ContainsKey("pending"); }
    }
    void Notify(string text, bool error) { status.Text = text; status.ForeColor = error ? Color.FromArgb(160, 55, 34) : Color.FromArgb(82, 96, 61); }
    async Task Action(string text, Func<Task> task) {
        if (!ready || actionBusy || closing) return; actionBusy = true; SetEnabled(); Notify(text, false);
        try { await task(); } catch (Exception e) { Notify(e.Message, true); }
        finally { actionBusy = false; SetEnabled(); }
        await RefreshState(); SetEnabled();
    }
    async Task CloseWallet() {
        if (closing) return; poll.Stop(); Notify(NiuLanguage.T("正在停止节点并保存数据…"), false);
        try {
            if (!String.IsNullOrEmpty(token)) await Post("shutdown", new { });
            if (backend != null && !backend.HasExited) await Task.Run(delegate { return backend.WaitForExit(180000); });
            if (backend != null && !backend.HasExited) { Notify(NiuLanguage.T("节点仍在关闭，请稍候，不要强制结束进程。"), true); return; }
            // The process has exited. Do not wait indefinitely for inherited stdout
            // handles to close: that can strand the wallet and its single-instance mutex.
            closing = true; ready = false;
            if (backend != null) {
                try { backend.CancelOutputRead(); } catch (InvalidOperationException) { }
                try { backend.CancelErrorRead(); } catch (InvalidOperationException) { }
                backend.Dispose();
            }
            if (outputLog != null) { lock(outputLog) outputLog.Dispose(); }
            if (errorLog != null) { lock(errorLog) errorLog.Dispose(); }
            try { tray.Visible = false; tray.Dispose(); } catch { }
            Close();
        } catch (Exception e) { Notify(NiuLanguage.T("关闭失败：") + e.Message, true); }
    }
    void SaveSmoke(bool passed, string error) {
        var report = new { status = passed ? "passed" : "failed", error = error, ui = "Native Windows Forms desktop; sidebar navigation; no browser window launched", pages = pages.Count, mining = state == null ? (object)null : state["mining"], chainId = state == null ? (object)null : state["chainId"], heights = state == null ? (object)null : state["heights"], walletTotal = state == null ? "" : S(state,"walletTotal"), genesisHash = state == null ? "" : S(state,"genesisHash"), address = address, qrPayload = qrAddress, logo = File.Exists(Path.Combine(root,"assets","niu-gold-v4.png")), screenshot = "desktop-wallet.png", at = DateTime.UtcNow.ToString("o") };
        File.WriteAllText(Path.Combine(root, "runtime", "desktop-qa.json"), serializer.Serialize(report), Encoding.UTF8);
    }
    async Task SmokeTest() {
        try {
            if (pages.Count != 5 || address.Length != 42 || Convert.ToBoolean(state["mining"]) || receiveQr.Image == null || !ownedAddresses.Contains(qrAddress)) throw new Exception("Native wallet initial state mismatch");
            string initialLanguage=NiuLanguage.Current;
            string initialAddress=address,initialQr=qrAddress,initialBalance=balance.Text;
            foreach(string code in NiuLanguage.Codes) {
                ((ToolStripMenuItem)languageMenu.Items[Array.IndexOf(NiuLanguage.Codes,code)]).PerformClick();
                if(address!=initialAddress||qrAddress!=initialQr||balance.Text!=initialBalance||!minerState.Text.StartsWith(NiuLanguage.T("挖矿状态：")))throw new Exception("Live language switch changed wallet state");
            }
            ((ToolStripMenuItem)languageMenu.Items[Array.IndexOf(NiuLanguage.Codes,initialLanguage)]).PerformClick();
            await Task.Run(delegate{
                using(var securityCheck=Process.Start(new ProcessStartInfo(Path.Combine(root,"engine","node.exe"),"scripts/check-http.mjs") {WorkingDirectory=root,UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8})){
                    var output=securityCheck.StandardOutput.ReadToEndAsync();var error=securityCheck.StandardError.ReadToEndAsync();
                    if(!securityCheck.WaitForExit(45000)){securityCheck.Kill();throw new Exception("HTTP boundary check timed out");}
                    Task.WaitAll(output,error);if(securityCheck.ExitCode!=0)throw new Exception(error.Result);
                    File.WriteAllText(Path.Combine(root,"runtime","http-security-qa.json"),output.Result,Encoding.UTF8);
                }
            });
            // Unlock before exercising signed actions. In smoke mode EnsureUnlocked
            // satisfies the local gate without a dialog; skipping it here left the
            // whole desktop smoke test failing at the first address creation.
            if(!await EnsureUnlocked())return;
            var added=await Post("new-address",new {label=NiuLanguage.T("备用收款地址")});string addedAddress=S(added,"address");accountSignature="";await RefreshState();
            if(addedAddress==address||qrAddress!=addedAddress||!ownedAddresses.Contains(addedAddress))throw new Exception("New receive address or QR refresh failed");
            await Post("contact",new {address=recipient,label=NiuLanguage.T("朋友的钱包")});await RefreshState();contactBook.SelectedIndex=0;
            if(sendTo.Text!=recipient)throw new Exception("Address book selection failed");
            SelectPage(1);await Task.Delay(200);using(Bitmap sendImage=new Bitmap(Width,Height)){DrawToBitmap(sendImage,new Rectangle(0,0,Width,Height));sendImage.Save(Path.Combine(root,"runtime","desktop-send.png"));}
            SelectPage(1); sendTo.Text = "invalid-address"; send.PerformClick();
            DateTime limit = DateTime.UtcNow.AddSeconds(15); while (actionBusy && DateTime.UtcNow < limit) await Task.Delay(100);
            if (String.IsNullOrWhiteSpace(status.Text) || status.ForeColor != Color.FromArgb(160, 55, 34)) throw new Exception("Invalid-address feedback missing");
            SelectPage(4); backup.PerformClick(); limit = DateTime.UtcNow.AddSeconds(90); while (actionBusy && DateTime.UtcNow < limit) await Task.Delay(100);
            if (!File.Exists(backupPath.Text)) throw new Exception("Native backup button failed: " + status.Text);
            // History page: the detail panel must expose the full 66-character hash.
            SelectPage(3); await Task.Delay(200);
            if (transactions.Items.Count > 0) {
                transactions.Items[0].Selected = true; await Task.Delay(80);
                if (txDetailHash.Text.Length != 66) throw new Exception("Detail panel does not show a full hash: " + txDetailHash.Text);
                if (!txDetailMeta.Text.Contains(NiuLanguage.T("完整交易哈希"))) throw new Exception("Detail panel is missing the hash row");
            } else if (txDetailHash.Text != NiuLanguage.T("请选择一笔交易")) throw new Exception("Detail placeholder missing: " + txDetailHash.Text);
            // Drive the announcement path with a synthetic payment: it proves the
            // banner, status line and tray wiring work even on a chain where no
            // transfer has arrived yet. It is never written to the ledger.
            // Switch to the overview first: a banner living on a hidden page reports
            // Visible=false, so the check has to run where the user would see it.
            SelectPage(0); await Task.Delay(300);
            var sample = new Dictionary<string, object> { {"hash", "0x" + new string('a', 64)}, {"dir", "in"}, {"kind", "收款"}, {"amount", "12.5"}, {"from", "0x" + new string('b', 40)}, {"to", address}, {"status", "confirmed"}, {"confirmations", "3"}, {"blockHash", "0x" + new string('c', 64)}, {"at", DateTime.UtcNow.ToString("o")} };
            AnnounceIncoming(sample);
            if (!incomingBanner.Visible || !incomingText.Text.Contains("12.5") || !incomingText.Text.Contains("NIU")) throw new Exception("Incoming banner did not render: " + incomingText.Text);
            using (Bitmap image = new Bitmap(Width, Height)) { DrawToBitmap(image, new Rectangle(0, 0, Width, Height)); image.Save(Path.Combine(root, "runtime", "desktop-incoming.png")); }
            incomingBanner.Visible = false; incomingBannerUntil = DateTime.MinValue;
            SelectPage(3); await Task.Delay(200);
            using (Bitmap image = new Bitmap(Width, Height)) { DrawToBitmap(image, new Rectangle(0, 0, Width, Height)); image.Save(Path.Combine(root, "runtime", "desktop-transactions.png")); }
            SelectPage(0); await Task.Delay(400);
            using (Bitmap image = new Bitmap(Width, Height)) { DrawToBitmap(image, new Rectangle(0, 0, Width, Height)); image.Save(Path.Combine(root, "runtime", "desktop-wallet.png")); }
            SelectPage(2); await Task.Delay(200);
            using (Bitmap image = new Bitmap(Width, Height)) { DrawToBitmap(image, new Rectangle(0, 0, Width, Height)); image.Save(Path.Combine(root, "runtime", "desktop-receive.png")); }
            receiveQr.Image.Save(Path.Combine(root, "runtime", "receive-qr.png"));
            SaveSmoke(true, null);
        } catch (Exception e) { SaveSmoke(false, e.Message); }
        await CloseWallet();
    }
}
