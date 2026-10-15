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
    [STAThread] static void Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        bool created;
        using (Mutex mutex = new Mutex(true, "Local\\NIUWalletDesktopLocalAlpha", out created)) {
            if (!created) { MessageBox.Show("牛币钱包已打开，请使用已有窗口。", "牛币钱包"); return; }
            Application.Run(new WalletForm(Array.IndexOf(args, "--smoke-test") >= 0));
        }
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
    System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer();

    public WalletForm(bool test) {
        smoke = test; Text = "牛币钱包  NIU Wallet"; ClientSize = new Size(1180, 760); MinimumSize = new Size(1100, 740);
        StartPosition = FormStartPosition.CenterScreen; Font = new Font("Microsoft YaHei UI", 10); BackColor = Color.FromArgb(246,240,223);
        string iconPath = Path.Combine(root, "assets", "niu-banknote-v2.ico");
        if (File.Exists(iconPath)) Icon = new Icon(iconPath);
        var header = new Panel { Dock = DockStyle.Top, Height = 76, BackColor = Color.White, Padding = new Padding(24, 12, 24, 8) };
        string logoPath = Path.Combine(root, "assets", "niu-banknote-v2.png");
        if (File.Exists(logoPath)) header.Controls.Add(new PictureBox { Image = Image.FromFile(logoPath), SizeMode = PictureBoxSizeMode.Zoom, Location = new Point(22, 13), Size = new Size(50, 50) });
        header.Controls.Add(new Label { Text = "牛币钱包", Font = new Font(Font.FontFamily, 18, FontStyle.Bold), AutoSize = true, Location = new Point(88, 20) });
        header.Controls.Add(new Label { Text = "NIU WALLET", Font = new Font("Segoe UI", 9, FontStyle.Bold), AutoSize = true, ForeColor = Color.FromArgb(123, 115, 91), Location = new Point(240, 30) });
        var motto = new Label { Text = "慢慢来，也很牛。", Dock=DockStyle.Right, Width=200, TextAlign=ContentAlignment.MiddleRight, ForeColor = Color.FromArgb(123, 115, 91) }; header.Controls.Add(motto);
        workspace.Dock = DockStyle.Fill; workspace.BackColor = Color.White;
        navigation.Dock = DockStyle.Left; navigation.Width = 182; navigation.BackColor = Color.FromArgb(237,238,224);
        navigation.Controls.Add(L("我的钱包", 22, 24, 145, 9));
        var body = new Panel { Dock = DockStyle.Fill }; body.Controls.Add(workspace); body.Controls.Add(navigation);
        var footer = new Panel { Dock = DockStyle.Bottom, Height = 46, BackColor = Color.FromArgb(248, 247, 242), Padding = new Padding(20, 10, 20, 8) };
        status.Dock = DockStyle.Fill; status.Text = "正在启动本机节点并读取加密钱包…"; status.ForeColor = Color.FromArgb(82, 96, 61);
        footer.Controls.Add(status); footer.Controls.Add(new Label { Text = "本机网络 · 开发中", Dock = DockStyle.Right, Width = 160, TextAlign = ContentAlignment.MiddleRight, ForeColor = Color.FromArgb(123,115,91), Font = new Font(Font.FontFamily,9) });
        Controls.Add(body); Controls.Add(header); Controls.Add(footer);
        BuildOverview(); BuildSend(); BuildReceive(); BuildTransactions(); BuildMining(); BuildContract(); BuildBackup();
        foreach(var combo in new ComboBox[]{receiveAccounts,sendAccounts,contactBook}){
            combo.DrawMode=DrawMode.OwnerDrawFixed;combo.ItemHeight=24;combo.DropDownWidth=840;
            combo.DrawItem+=delegate(object sender,DrawItemEventArgs e){
                e.DrawBackground();var box=(ComboBox)sender;
                string text=e.Index>=0&&e.Index<box.Items.Count?Convert.ToString(box.Items[e.Index]):"请选择地址";
                TextRenderer.DrawText(e.Graphics,text,box.Font,e.Bounds,e.ForeColor,TextFormatFlags.Left|TextFormatFlags.VerticalCenter|TextFormatFlags.EndEllipsis);e.DrawFocusRectangle();
            };
        }
        SelectPage(0); SetEnabled();
        poll.Interval = 3000; poll.Tick += async delegate { await RefreshState(); };
        Shown += async delegate { await StartWallet(); };
        FormClosing += async delegate(object sender, FormClosingEventArgs e) {
            if (closing) return;
            e.Cancel = true;
            if (actionBusy) { Notify("操作尚未结束，请等待交易结果后关闭。", true); return; }
            if (starting && backend != null && !backend.HasExited) { closeAfterReady = true; Notify("正在完成启动，随后会正常关闭节点。", false); return; }
            await CloseWallet();
        };
    }
    Panel Page(string name) {
        int index = pages.Count; var p = new Panel { BackColor = Color.FromArgb(253,252,247), Padding = new Padding(24), Dock = DockStyle.Fill, Visible = false }; pages.Add(p); workspace.Controls.Add(p);
        var nav = new Button { Text = name, Location = new Point(14,64 + index*54), Size = new Size(154,44), TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(16,0,0,0), FlatStyle = FlatStyle.Flat, BackColor = navigation.BackColor, ForeColor = Color.FromArgb(71,68,58), UseVisualStyleBackColor = false, Font = new Font(Font.FontFamily,11) };
        nav.FlatAppearance.BorderSize = 0; nav.Click += delegate { SelectPage(index); }; navButtons.Add(nav); navigation.Controls.Add(nav); return p;
    }
    void SelectPage(int index) { for(int i=0;i<pages.Count;i++){pages[i].Visible=i==index;navButtons[i].BackColor=i==index?Color.FromArgb(216,226,207):navigation.BackColor;navButtons[i].Font=new Font(Font.FontFamily,11,i==index?FontStyle.Bold:FontStyle.Regular);} pages[index].BringToFront(); }
    Label L(string text, int x, int y, int width = 900, int size = 10) { return new Label { Text = text, Location = new Point(x, y), Size = new Size(width, 30), Font = new Font(Font.FontFamily, size), AutoEllipsis = true }; }
    Button B(string text, int x, int y, EventHandler handler, int width = 155) { var b = new Button { Text = text, Location = new Point(x, y), Size = new Size(width, 42), BackColor = Color.FromArgb(33,77,60), ForeColor = Color.FromArgb(250,246,231), FlatStyle = FlatStyle.Flat, UseVisualStyleBackColor=false }; b.FlatAppearance.BorderSize = 0; b.Click += handler; buttons.Add(b); return b; }
    void BuildOverview() {
        var p = Page("概览"); p.Controls.Add(L("钱包概览", 36, 30, 500, 19));
        var card=new BanknotePanel {Location=new Point(36,90),Size=new Size(850,190),BackColor=Color.FromArgb(246,240,223)};p.Controls.Add(card);
        var caption=L("钱包总余额",20,20,600);caption.ForeColor=Color.FromArgb(73,101,80);caption.BackColor=card.BackColor;card.Controls.Add(caption);
        balance = L("— NIU", 20, 60, 600, 38);balance.Font=new Font("Georgia",38,FontStyle.Regular);balance.BackColor=card.BackColor;balance.ForeColor=Color.FromArgb(33,77,60);balance.Height = 72; card.Controls.Add(balance);
        string coinPath=Path.Combine(root,"assets","niu-banknote-v2.png");if(File.Exists(coinPath))card.Controls.Add(new PictureBox {Image=Image.FromFile(coinPath),SizeMode=PictureBoxSizeMode.Zoom,Location=new Point(668,19),Size=new Size(150,150),BackColor=card.BackColor});
        p.Controls.Add(L("默认挖矿地址", 36, 304)); overviewAddress = L("正在读取…", 36, 342); overviewAddress.Font = new Font("Consolas", 11); p.Controls.Add(overviewAddress);
        p.Controls.Add(B("发送 NIU",36,402,delegate {SelectPage(1);},150));p.Controls.Add(B("接收 NIU",204,402,delegate {SelectPage(2);},150));
        height = L("区块高度：—", 36, 466); peerState = L("连接：—", 36, 508); minerState = L("挖矿：—", 350, 508, 400);
        p.Controls.Add(height); p.Controls.Add(peerState); p.Controls.Add(minerState);
        foreach (Control control in p.Controls) if (control is PictureBox) control.BringToFront();
    }
    void BuildSend() {
        var p = Page("发送"); p.Controls.Add(L("发送 NIU", 36, 30, 500, 19));
        p.Controls.Add(L("从我的地址发送", 36, 88)); sendAccounts.Location = new Point(36,124);sendAccounts.Width=820;sendAccounts.DropDownStyle=ComboBoxStyle.DropDownList;p.Controls.Add(sendAccounts);
        p.Controls.Add(L("收款钱包地址",36,176));sendTo.Location=new Point(36,212);sendTo.Width=820;p.Controls.Add(sendTo);
        contactBook.Location=new Point(36,258);contactBook.Width=580;contactBook.DropDownStyle=ComboBoxStyle.DropDownList;p.Controls.Add(contactBook);
        contactBook.SelectedIndexChanged+=delegate{if(contactBook.SelectedIndex>=0&&contactBook.SelectedIndex<contactAddresses.Count)sendTo.Text=contactAddresses[contactBook.SelectedIndex];};
        fill=B("保存到地址簿",636,252,async delegate{string label=AskLabel("联系人备注");if(label==null)return;await Action("正在保存联系人…",async delegate{await Post("contact",new {address=sendTo.Text.Trim(),label=label});Notify("联系人已保存，可从地址簿选择。",false);});},220);p.Controls.Add(fill);
        p.Controls.Add(L("数量（NIU，最多18位小数）",36,324));amount.Location=new Point(36,360);amount.Width=300;amount.Text="0.1";p.Controls.Add(amount);
        send=B("签名并发送",36,422,async delegate{await Action("正在发送并等待区块确认…",async delegate{
            string from=sendAccounts.SelectedIndex>=0&&sendAccounts.SelectedIndex<ownedAddresses.Count?ownedAddresses[sendAccounts.SelectedIndex]:address;
            if(!smoke&&MessageBox.Show(this,"发送地址："+from+"\n收款地址："+sendTo.Text.Trim()+"\n数量："+amount.Text.Trim()+" NIU\n\n确认后签名并广播，交易还需要支付手续费。","确认转账",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)!=DialogResult.OK)return;
            await Post("transfer",new {to=sendTo.Text.Trim(),amount=amount.Text.Trim(),from=from});Notify("交易已入块，可在交易记录中查看确认数。",false);
        });});p.Controls.Add(send);
        p.Controls.Add(L("从所选地址扣款。各地址余额不能自动合并；地址簿只保存公开地址。",36,486));
    }
    void BuildReceive() {
        var p = Page("接收"); p.Controls.Add(L("接收 NIU", 36, 30, 500, 19));
        p.Controls.Add(L("我的收款地址",36,88));receiveAccounts.Location=new Point(36,124);receiveAccounts.Width=620;receiveAccounts.DropDownStyle=ComboBoxStyle.DropDownList;p.Controls.Add(receiveAccounts);
        receiveAccounts.SelectedIndexChanged+=delegate{UpdateReceiveAddress();};
        p.Controls.Add(B("新增收款地址",680,118,async delegate{string label=AskLabel("收款地址备注（可留空）");if(label==null)return;await Action("正在创建并加密保存地址…",async delegate{var created=await Post("new-address",new {label=label});accountSignature="";Notify("新地址已保存。请重新导出备份，旧备份不包含新地址。",false);});},180));
        receiveAddress=L("正在读取…",36,186);receiveAddress.Font=new Font("Consolas",12);p.Controls.Add(receiveAddress);
        p.Controls.Add(B("复制收款地址",36,240,delegate{try{if(qrAddress.Length!=42)throw new Exception();Clipboard.SetText(qrAddress);Notify("收款地址已复制。",false);}catch{Notify("地址尚未就绪或复制失败。",true);}}));
        receiveQr.Location=new Point(36,310);receiveQr.Size=new Size(200,200);receiveQr.SizeMode=PictureBoxSizeMode.Zoom;receiveQr.BackColor=Color.White;p.Controls.Add(receiveQr);
        p.Controls.Add(L("每个地址由你自己的钱包控制，并有独立的二维码。",280,328,600));
        var warning=L("扫描前确认网络。新增地址后，请重新导出完整备份。",280,380,600);warning.Height=64;p.Controls.Add(warning);
    }
    string AskLabel(string title) {
        using(var dialog=new Form {Text=title,ClientSize=new Size(460,150),FormBorderStyle=FormBorderStyle.FixedDialog,StartPosition=FormStartPosition.CenterParent,MinimizeBox=false,MaximizeBox=false,Font=Font}){
            var input=new TextBox {Location=new Point(20,24),Width=420,MaxLength=40};dialog.Controls.Add(input);
            var ok=new Button {Text="确定",Location=new Point(240,88),Width=95,DialogResult=DialogResult.OK};dialog.Controls.Add(ok);
            var cancel=new Button {Text="取消",Location=new Point(345,88),Width=95,DialogResult=DialogResult.Cancel};dialog.Controls.Add(cancel);
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
        var p = Page("交易记录"); transactions.Dock = DockStyle.Fill; transactions.View = View.Details; transactions.FullRowSelect = true; transactions.GridLines = true;
        transactions.Columns.Add("操作", 105); transactions.Columns.Add("状态", 100); transactions.Columns.Add("区块", 80); transactions.Columns.Add("交易哈希", 570);
        p.Controls.Add(transactions);
    }
    void BuildMining() {
        var p = Page("挖矿"); p.Controls.Add(L("挖矿", 36, 30, 500, 19));
        p.Controls.Add(L("使用真实 Ethash 工作量证明。每次开启使用2个CPU线程，最多运行10分钟。", 24, 100));
        p.Controls.Add(L("首次生成挖矿数据集或找到区块需要等待，当前未提供GPU矿工或矿池功能。", 24, 145));
        mine = B("开启挖矿", 24, 220, async delegate { await Action("正在切换挖矿状态…", async delegate { bool enabled = state == null || !Convert.ToBoolean(state["mining"]); await Post("mine", new { enabled = enabled }); Notify(enabled ? "已开启挖矿，请等待有效区块。" : "挖矿已停止。", false); }); }, 190); p.Controls.Add(mine);
        p.Controls.Add(L("关闭钱包窗口会正常停止节点与挖矿；再次打开不会自动开始挖矿。", 24, 320));
    }
    void BuildContract() {
        var p = Page("智能合约"); p.Controls.Add(L("Solidity 留言合约", 24, 24, 500, 17));
        p.Controls.Add(L("输入留言；部署与修改需要开启挖矿，并消耗测试NIU手续费。", 24, 80));
        message.Location = new Point(24, 122); message.Size = new Size(820, 90); message.Multiline = true; message.MaxLength = 160; message.Text = "慢慢来，也很牛。"; p.Controls.Add(message);
        deploy = B("部署留言合约", 24, 238, async delegate { await Action("正在部署合约并等待确认…", async delegate { await Post("deploy", new { message = message.Text }); Notify("合约部署已确认。", false); }); });
        update = B("更新链上留言", 200, 238, async delegate { await Action("正在修改留言并等待确认…", async delegate { await Post("message", new { message = message.Text }); Notify("链上留言已更新。", false); }); });
        p.Controls.Add(deploy); p.Controls.Add(update); p.Controls.Add(L("当前链上留言", 24, 306));
        currentMessage = L("尚未部署", 24, 346, 900, 15); currentMessage.Height = 56; p.Controls.Add(currentMessage);
        contractAddress = L("", 24, 420); contractAddress.Font = new Font("Consolas", 10); p.Controls.Add(contractAddress);
    }
    void BuildBackup() {
        var p = Page("备份与设置"); p.Controls.Add(L("加密钱包备份", 24, 24, 500, 17));
        p.Controls.Add(L("本机密钥由 Windows 账户保护；导出的备份使用你设置的独立密码加密。", 24, 90));
        p.Controls.Add(L("备份可用于换电脑或重装系统。文件和密码缺一不可，项目方无法找回密码。", 24, 130));
        backup = B("保存加密备份", 24, 190, async delegate {
            string password = smoke ? "QA-only-" + Guid.NewGuid().ToString() : AskPassword(true);
            if (password == null) return;
            await Action("正在加密并校验备份…", async delegate { var v = await Post("backup-portable", new { password = password }); backupPath.Text = S(v, "path"); Notify("备份已加密并通过回读校验。请将文件和密码分开保管。", false); });
            password = null;
        }, 185); p.Controls.Add(backup);
        backupPath.Location = new Point(24, 250); backupPath.Size = new Size(850, 60); backupPath.Multiline = true; backupPath.ReadOnly = true; p.Controls.Add(backupPath);
        backupWarning=L("",24,310,850,9);backupWarning.ForeColor=Color.FromArgb(149,92,31);p.Controls.Add(backupWarning);
        p.Controls.Add(L("恢复：在新解压的钱包首次启动时选择“恢复备份”。不覆盖已有钱包。", 24, 340));
        p.Controls.Add(L("关于与网络",24,382,500,12));
        var about=L("本地开发网络：发行规则和朋友之间联网尚未完成，当前余额不承诺迁移。\nCore-Geth v1.12.23 · London EVM · 未签名，未独立审计。",24,420,870,9);about.Height=70;p.Controls.Add(about);
    }
    string AskPassword(bool confirm) {
        using (var dialog = new Form { Text = confirm ? "设置备份密码" : "输入备份密码", ClientSize = new Size(470, 240), FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterParent, MinimizeBox = false, MaximizeBox = false, Font = Font }) {
            dialog.Controls.Add(new Label { Text = "至少12个字符。请妥善保存，丢失后无法恢复。", AutoSize = true, Location = new Point(20,20) });
            var password = new TextBox { Location = new Point(20,60), Width = 425, UseSystemPasswordChar = true, MaxLength = 256 }; dialog.Controls.Add(password);
            var repeated = new TextBox { Location = new Point(20,120), Width = 425, UseSystemPasswordChar = true, MaxLength = 256, Visible = confirm }; dialog.Controls.Add(repeated);
            if (confirm) dialog.Controls.Add(new Label { Text = "再次输入密码", AutoSize = true, Location = new Point(20,96) });
            var ok = new Button { Text = "确定", Location = new Point(245,180), Width = 95 }; dialog.Controls.Add(ok);
            var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Location = new Point(350,180), Width = 95 }; dialog.Controls.Add(cancel);
            ok.Click += delegate { if (password.Text.Length < 12 || (confirm && password.Text != repeated.Text)) { MessageBox.Show(dialog,"密码至少12个字符，且两次输入必须一致。","请检查密码"); return; } dialog.DialogResult = DialogResult.OK; };
            dialog.AcceptButton = ok; dialog.CancelButton = cancel;
            if (dialog.ShowDialog(this) != DialogResult.OK) return null;
            string value = password.Text; password.Clear(); repeated.Clear(); return value;
        }
    }
    async Task RestoreBeforeStart() {
        if (smoke || File.Exists(Path.Combine(root,"runtime","persistent","wallet.dpapi"))) return;
        var choice = MessageBox.Show(this,"创建新的钱包吗？\n\n是：创建新钱包\n否：从加密备份恢复\n取消：暂不启动", "欢迎使用牛币钱包", MessageBoxButtons.YesNoCancel);
        if (choice == DialogResult.Cancel) throw new Exception("已取消钱包初始化。");
        if (choice == DialogResult.Yes) return;
        using (var picker = new OpenFileDialog { Filter = "牛币加密备份 (*.json)|*.json", CheckFileExists = true }) {
            if (picker.ShowDialog(this) != DialogResult.OK) throw new Exception("已取消备份恢复。");
            string password = AskPassword(false); if (password == null) throw new Exception("已取消备份恢复。");
            var payload = serializer.Serialize(new { path = picker.FileName, password = password });
            await Task.Run(delegate {
                using (var process = new Process { StartInfo = new ProcessStartInfo(Path.Combine(root,"engine","node.exe"),"scripts/restore-wallet.mjs") { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 } }) {
                    process.Start(); byte[] input = Encoding.UTF8.GetBytes(payload); process.StandardInput.BaseStream.Write(input,0,input.Length); process.StandardInput.Close(); Array.Clear(input,0,input.Length);
                    var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(90000)) { process.Kill(); throw new Exception("恢复超时，请检查备份文件。原钱包未覆盖。"); }
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
            if (!File.Exists(Path.Combine(root, "engine", "node.exe"))) throw new Exception("请完整解压Windows钱包下载包后启动，缺少engine/node.exe。");
            bool occupied = false; try { await Request("/api/state"); occupied = true; } catch { }
            if (occupied) throw new Exception("本机已有钱包服务占用18790端口，请先关闭已有钱包。不会切换到另一个目录的钱包。");
            await RestoreBeforeStart();
            Directory.CreateDirectory(Path.Combine(root, "runtime"));
            outputLog = new StreamWriter(Path.Combine(root, "runtime", "desktop-console.log"), true, Encoding.UTF8) { AutoFlush = true };
            errorLog = new StreamWriter(Path.Combine(root, "runtime", "desktop-error.log"), true, Encoding.UTF8) { AutoFlush = true };
            backend = new Process(); backend.StartInfo = new ProcessStartInfo(Path.Combine(root, "engine", "node.exe"), "scripts/server.mjs") { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
            backend.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) { lock (outputLog) outputLog.WriteLine(e.Data); } };
            backend.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) { lock (errorLog) errorLog.WriteLine(e.Data); } };
            backend.Start(); backend.BeginOutputReadLine(); backend.BeginErrorReadLine();
            DateTime limit = DateTime.UtcNow.AddSeconds(90);
            while (DateTime.UtcNow < limit) {
                if (backend.HasExited) throw new Exception("后台节点已退出，请检查runtime/desktop-error.log。");
                Dictionary<string, object> v = null;
                try { v = D(serializer.DeserializeObject(await Request("/api/state"))); } catch { }
                if (v != null && v.ContainsKey("chainId")) {
                    string expected = Path.GetFullPath(Path.Combine(root, "runtime", "persistent")).TrimEnd('\\');
                    if (!String.Equals(Path.GetFullPath(S(v, "dataPath")).TrimEnd('\\'), expected, StringComparison.OrdinalIgnoreCase)) throw new Exception("节点数据目录不匹配，拒绝连接。");
                    state = v; break;
                }
                await Task.Delay(1000);
            }
            if (state == null) throw new Exception("节点启动超时，请检查日志；不要删除钱包文件。");
            token = Regex.Match(await Request("/"), "name=\"niu-token\" content=\"([^\"]+)\"").Groups[1].Value;
            if (token.Length == 0) throw new Exception("钱包本机会话初始化失败。");
            ready = true; Render(); SetEnabled(); poll.Start(); Notify("钱包节点已就绪，挖矿默认关闭。请查看节点连接与同步状态。", false);
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
        try { state = D(serializer.DeserializeObject(await Request("/api/state"))); Render(); } catch (Exception e) { Notify("读取节点失败：" + e.Message, true); }
        finally { refreshing = false; }
    }
    void Render() {
        var wallets = A(state["wallets"]); var w = D(wallets[0]); address = S(w, "address"); recipient = S(D(wallets[1]), "address");
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
        backupWarning.Text=state.ContainsKey("backupRequired")&&Convert.ToBoolean(state["backupRequired"])?"尚有地址未包含在当前备份中，请重新保存完整加密备份。":"当前所有地址已包含在最近导出的备份中。";
        if(state.ContainsKey("contacts")){string contactsKey=serializer.Serialize(state["contacts"]);if(contactsKey!=contactSignature){contactBook.Items.Clear();contactAddresses.Clear();foreach(object item in A(state["contacts"])){var contact=D(item);contactAddresses.Add(S(contact,"address"));contactBook.Items.Add(S(contact,"label")+"  |  "+S(contact,"address"));}contactSignature=contactsKey;}}
        var heights = A(state["heights"]); height.Text = "区块高度  " + heights[0];
        if (heights.Length > 1) height.Text += "       验证节点高度  " + heights[1];
        var sync = state.ContainsKey("syncing") ? state["syncing"] as Dictionary<string,object> : null;
        if (sync != null) height.Text += "       同步中  " + S(sync,"currentBlock") + " / " + S(sync,"highestBlock");
        peerState.Text = "节点连接  " + state["peers"] + (S(state,"connectionStatus") == "disconnected" ? " · 未联网" : sync != null ? " · 正在同步" : " · 已连接");
        bool active = Convert.ToBoolean(state["mining"]); minerState.Text = "挖矿状态：" + (active ? "挖矿中（最多十分钟）" : "已停止"); mine.Text = active ? "停止挖矿" : "开启挖矿";
        transactions.BeginUpdate(); transactions.Items.Clear();
        foreach (object item in A(state["transactions"])) { var tx = D(item); string txStatus = S(tx, "status"); var row = new ListViewItem(S(tx, "kind")); row.SubItems.Add(txStatus == "confirmed" ? "已入块 " + S(tx,"confirmations") : txStatus == "failed" ? "执行失败" : txStatus == "reorged" ? "链重组待确认" : "等待确认"); row.SubItems.Add(S(tx, "block")); row.SubItems.Add(S(tx, "hash")); transactions.Items.Add(row); }
        transactions.EndUpdate();
        var c = state["contract"] as Dictionary<string, object>; currentMessage.Text = c == null ? "尚未部署" : c.ContainsKey("pending") ? "部署等待确认…" : S(c, "message"); contractAddress.Text = c == null ? "" : S(c, "address"); SetEnabled();
    }
    void SetEnabled() {
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
        if (closing) return; poll.Stop(); Notify("正在停止节点并保存数据…", false);
        try {
            if (!String.IsNullOrEmpty(token)) await Post("shutdown", new { });
            if (backend != null && !backend.HasExited) await Task.Run(delegate { return backend.WaitForExit(30000); });
            if (backend != null && !backend.HasExited) { Notify("节点仍在关闭，请稍候，不要强制结束进程。", true); return; }
            if (backend != null) backend.WaitForExit();
            closing = true; ready = false; if (outputLog != null) outputLog.Dispose(); if (errorLog != null) errorLog.Dispose(); Close();
        } catch (Exception e) { Notify("关闭失败：" + e.Message, true); }
    }
    void SaveSmoke(bool passed, string error) {
        var report = new { status = passed ? "passed" : "failed", error = error, ui = "Native Windows Forms desktop; sidebar navigation; no browser window launched", pages = pages.Count, mining = state == null ? (object)null : state["mining"], address = address, qrPayload = qrAddress, logo = File.Exists(Path.Combine(root,"assets","niu-logo.png")), screenshot = "desktop-wallet.png", at = DateTime.UtcNow.ToString("o") };
        File.WriteAllText(Path.Combine(root, "runtime", "desktop-qa.json"), serializer.Serialize(report), Encoding.UTF8);
    }
    async Task SmokeTest() {
        try {
            if (pages.Count != 7 || address.Length != 42 || Convert.ToBoolean(state["mining"]) || receiveQr.Image == null || !ownedAddresses.Contains(qrAddress)) throw new Exception("Native wallet initial state mismatch");
            await Task.Run(delegate{
                using(var securityCheck=Process.Start(new ProcessStartInfo(Path.Combine(root,"engine","node.exe"),"scripts/check-http.mjs") {WorkingDirectory=root,UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8})){
                    var output=securityCheck.StandardOutput.ReadToEndAsync();var error=securityCheck.StandardError.ReadToEndAsync();
                    if(!securityCheck.WaitForExit(45000)){securityCheck.Kill();throw new Exception("HTTP boundary check timed out");}
                    Task.WaitAll(output,error);if(securityCheck.ExitCode!=0)throw new Exception(error.Result);
                    File.WriteAllText(Path.Combine(root,"runtime","http-security-qa.json"),output.Result,Encoding.UTF8);
                }
            });
            var added=await Post("new-address",new {label="备用收款地址"});string addedAddress=S(added,"address");accountSignature="";await RefreshState();
            if(addedAddress==address||qrAddress!=addedAddress||!ownedAddresses.Contains(addedAddress))throw new Exception("New receive address or QR refresh failed");
            await Post("contact",new {address=recipient,label="朋友的钱包"});await RefreshState();contactBook.SelectedIndex=0;
            if(sendTo.Text!=recipient)throw new Exception("Address book selection failed");
            SelectPage(1);await Task.Delay(200);using(Bitmap sendImage=new Bitmap(Width,Height)){DrawToBitmap(sendImage,new Rectangle(0,0,Width,Height));sendImage.Save(Path.Combine(root,"runtime","desktop-send.png"));}
            SelectPage(1); sendTo.Text = "invalid-address"; send.PerformClick();
            DateTime limit = DateTime.UtcNow.AddSeconds(15); while (actionBusy && DateTime.UtcNow < limit) await Task.Delay(100);
            if (!status.Text.Contains("地址")) throw new Exception("Invalid-address feedback missing");
            SelectPage(6); backup.PerformClick(); limit = DateTime.UtcNow.AddSeconds(90); while (actionBusy && DateTime.UtcNow < limit) await Task.Delay(100);
            if (!File.Exists(backupPath.Text)) throw new Exception("Native backup button failed: " + status.Text);
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
