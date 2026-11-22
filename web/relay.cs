using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

public sealed class WebShopFront
{
    const string ReplyMime = "application/vnd.webshop.reply+json";
    const int HistoryLimit = 32 * 1024 * 1024;
    static readonly Encoding Utf8 = new UTF8Encoding(false);
    static readonly HttpClient Http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });
    static readonly Regex KaggleHost = new Regex(@"^[a-z0-9-]+\.jupyter-proxy\.kaggle\.net$", RegexOptions.IgnoreCase);
    static readonly Regex KagglePath = new Regex(@"^/k/\d+/[A-Za-z0-9._~%=-]+/proxy$");
    static readonly Regex Identifier = new Regex(@"^[A-Za-z0-9_-]{1,100}$");
    readonly string root;
    readonly string historyFile;
    readonly object historyLock = new object();
    readonly string nonce = Guid.NewGuid().ToString("N");
    readonly string origin;
    readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 8771);

    WebShopFront(string root)
    {
        this.root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        historyFile = Path.Combine(Path.GetDirectoryName(this.root), "logs", "conversations.json");
        listener.Start();
        origin = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    public static void Run(string root, bool openBrowser)
    {
        var app = new WebShopFront(root);
        Console.WriteLine(app.origin);
        if (openBrowser)
        {
            try { Process.Start(new ProcessStartInfo(app.origin) { UseShellExecute = true }); }
            catch (System.ComponentModel.Win32Exception)
            {
                Console.WriteLine("Open the address above in Edge or Chrome.");
            }
            Console.WriteLine("Keep this window open while using the WebShop question desk.");
        }
        while (true)
        {
            var client = app.listener.AcceptTcpClient();
            Task.Run(() => app.Handle(client));
        }
    }

    static JavaScriptSerializer Json(int maxLength = 1024 * 1024)
    {
        return new JavaScriptSerializer { MaxJsonLength = maxLength };
    }

    static Dictionary<string, object> Object(object value)
    {
        var map = value as Dictionary<string, object>;
        if (map == null) throw new ArgumentException();
        return map;
    }

    static string StringValue(Dictionary<string, object> map, string name)
    {
        object value;
        return map.TryGetValue(name, out value) ? value as string ?? "" : "";
    }

    static string ReadLine(Stream stream)
    {
        using (var line = new MemoryStream())
        {
            while (line.Length < 8192)
            {
                int next = stream.ReadByte();
                if (next < 0 || next == '\n') return Encoding.ASCII.GetString(line.ToArray()).TrimEnd('\r');
                line.WriteByte((byte)next);
            }
        }
        throw new ArgumentException();
    }

    static string ReadBody(Stream stream, int length)
    {
        var bytes = new byte[length];
        int start = 0;
        while (start < length)
        {
            int count = stream.Read(bytes, start, length - start);
            if (count == 0) throw new ArgumentException();
            start += count;
        }
        return Utf8.GetString(bytes);
    }

    static void Reply(Stream stream, string status, string type, byte[] body)
    {
        var header = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + "\r\nContent-Type: " + type +
            "\r\nContent-Length: " + body.Length + "\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n" +
            "Referrer-Policy: no-referrer\r\nConnection: close\r\n\r\n");
        stream.Write(header, 0, header.Length);
        stream.Write(body, 0, body.Length);
    }

    static void ReplyJson(Stream stream, string status, object body, int maxLength = 1024 * 1024)
    {
        Reply(stream, status, "application/json; charset=utf-8", Utf8.GetBytes(Json(maxLength).Serialize(body)));
    }

    void Handle(TcpClient client)
    {
        using (client)
        using (var stream = client.GetStream())
        {
            client.ReceiveTimeout = 10000;
            client.SendTimeout = 10000;
            try
            {
                var request = ReadLine(stream).Split(' ');
                if (request.Length != 3) return;
                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                for (int i = 0; i < 50; i++)
                {
                    var line = ReadLine(stream);
                    if (line.Length == 0) break;
                    int colon = line.IndexOf(':');
                    if (colon <= 0 || i == 49) throw new ArgumentException();
                    headers[line.Substring(0, colon)] = line.Substring(colon + 1).Trim();
                }
                string host;
                if (!headers.TryGetValue("Host", out host) || "http://" + host != origin)
                {
                    ReplyJson(stream, "403 Forbidden", new { error = "origin" });
                    return;
                }
                if (request[0] == "GET")
                {
                    SendPage(stream, request[1]);
                    return;
                }
                string from, key, size, contentType;
                int length;
                bool history = request[1] == "/bridge/history";
                bool bridge = history || request[1] == "/bridge/kernels" || request[1] == "/bridge/execute";
                int bodyLimit = history ? HistoryLimit : 65536;
                if (request[0] != "POST" || !bridge ||
                    !headers.TryGetValue("Origin", out from) || from != origin ||
                    !headers.TryGetValue("X-WebShop-Front", out key) || key != nonce ||
                    !headers.TryGetValue("Content-Type", out contentType) || contentType != "application/json" ||
                    !headers.TryGetValue("Content-Length", out size) || !Int32.TryParse(size, out length) || length < 1 || length > bodyLimit ||
                    headers.ContainsKey("Transfer-Encoding"))
                {
                    ReplyJson(stream, "403 Forbidden", new { error = "origin" });
                    return;
                }
                var data = Object(Json(history ? HistoryLimit : 1024 * 1024).DeserializeObject(ReadBody(stream, length)));
                if (history)
                {
                    SaveHistory(stream, data);
                    return;
                }
                var api = KaggleUri(data, "/api/kernels");
                object result = request[1] == "/bridge/kernels"
                    ? GetKernels(api).GetAwaiter().GetResult()
                    : Execute(data).GetAwaiter().GetResult();
                ReplyJson(stream, "200 OK", result);
            }
            catch (IOException) { }
            catch (ArgumentException) { ReplyJson(stream, "400 Bad Request", new { error = "request" }); }
            catch (Exception) { ReplyJson(stream, "502 Bad Gateway", new { error = "kaggle" }); }
        }
    }

    void SaveHistory(Stream stream, Dictionary<string, object> request)
    {
        object result;
        try
        {
            result = MergeHistory(Object(request["history"]), request.ContainsKey("restore") && System.Object.Equals(request["restore"], true));
        }
        catch (IOException)
        {
            ReplyJson(stream, "500 Internal Server Error", new { error = "history" });
            return;
        }
        catch (UnauthorizedAccessException)
        {
            ReplyJson(stream, "500 Internal Server Error", new { error = "history" });
            return;
        }
        ReplyJson(stream, "200 OK", result, HistoryLimit);
    }

    static IEnumerable<object> HistoryItems(Dictionary<string, object> record, string key)
    {
        object value;
        if (!record.TryGetValue(key, out value)) return new object[0];
        var items = value as IEnumerable<object>;
        if (items == null) throw new ArgumentException("Invalid history collection.");
        return items;
    }

    object MergeHistory(Dictionary<string, object> incoming, bool restore)
    {
        if (!incoming.ContainsKey("schema") || !System.Object.Equals(incoming["schema"], 2)) throw new ArgumentException();
        lock (historyLock)
        {
            var serializer = Json(HistoryLimit);
            var currentText = File.Exists(historyFile) ? File.ReadAllText(historyFile, Utf8) : "";
            var current = currentText.Length == 0 ? new Dictionary<string, object>() : Object(serializer.DeserializeObject(currentText));
            var deleted = new HashSet<string>(HistoryItems(current, "deleted").Concat(HistoryItems(incoming, "deleted"))
                .OfType<string>().Where(id => Identifier.IsMatch(id)), StringComparer.Ordinal);
            var threads = HistoryItems(current, "threads").Concat(HistoryItems(incoming, "threads"))
                .Select(Object).Where(item => Identifier.IsMatch(StringValue(item, "id")) && !deleted.Contains(StringValue(item, "id")))
                .GroupBy(item => StringValue(item, "id"), StringComparer.Ordinal).Select(MergeThread).ToArray();
            var active = StringValue(incoming, "active");
            if (!Identifier.IsMatch(active)) active = StringValue(current, "active");
            var updated = new { schema = 2, active = active, threads = threads, deleted = deleted.OrderBy(id => id, StringComparer.Ordinal).ToArray() };
            if (threads.Length != 0 || deleted.Count != 0 || currentText.Length != 0)
            {
                var next = serializer.Serialize(updated);
                if (next != currentText) WriteHistory(next);
            }
            return restore ? (object)updated : new { saved = true };
        }
    }

    static object MergeThread(IGrouping<string, Dictionary<string, object>> thread)
    {
        var turns = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
        foreach (var entry in thread.SelectMany(item => HistoryItems(item, "events")).Select(Object))
        {
            var id = StringValue(entry, "questionId");
            if (id.Length == 0) id = StringValue(entry, "time");
            if (id.Length == 0) continue;
            Dictionary<string, object> saved;
            if (!turns.TryGetValue(id, out saved) || (IsPending(saved) && !IsPending(entry))) turns[id] = entry;
        }
        var events = turns.Values.OrderBy(item => StringValue(item, "time"), StringComparer.Ordinal).ToArray();
        var state = events.Reverse().Select(item => item.ContainsKey("answer") ? item["answer"] as Dictionary<string, object> : null)
            .Where(answer => answer != null && answer.ContainsKey("state")).Select(answer => answer["state"]).FirstOrDefault();
        if (state == null) state = thread.Reverse().Where(item => item.ContainsKey("state")).Select(item => item["state"]).FirstOrDefault();
        return new { id = thread.Key, state = state ?? new Dictionary<string, object>(), events = events };
    }

    static bool IsPending(Dictionary<string, object> entry)
    {
        object value;
        return entry.TryGetValue("pending", out value) && System.Object.Equals(value, true);
    }

    void WriteHistory(string json)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(historyFile));
        var temporary = historyFile + ".tmp";
        try
        {
            File.WriteAllText(temporary, json, Utf8);
            if (File.Exists(historyFile)) File.Replace(temporary, historyFile, null);
            else File.Move(temporary, historyFile);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    void SendPage(Stream stream, string path)
    {
        if (path == "/")
        {
            var page = File.ReadAllText(Path.Combine(root, "index.html"), Utf8)
                .Replace("</head>", "  <meta name=\"webshop-front\" content=\"" + nonce + "\">\n</head>")
                .Replace("connect-src ", "connect-src 'self' ");
            Reply(stream, "200 OK", "text/html; charset=utf-8", Utf8.GetBytes(page));
            return;
        }
        if (Regex.IsMatch(path, @"^/kaggle-guide/[a-z0-9-]+\.png$"))
        {
            var asset = Path.Combine(root, "kaggle-guide", Path.GetFileName(path));
            if (File.Exists(asset))
            {
                Reply(stream, "200 OK", "image/png", File.ReadAllBytes(asset));
                return;
            }
        }
        switch (path)
        {
            case "/app.js":
            case "/rag.js":
            case "/catalog.js":
            case "/policy.js":
            case "/style.css":
                string type = path.EndsWith(".css") ? "text/css" : "text/javascript";
                Reply(stream, "200 OK", type + "; charset=utf-8", File.ReadAllBytes(Path.Combine(root, path.Substring(1))));
                break;
            default:
                ReplyJson(stream, "404 Not Found", new { error = "page" });
                break;
        }
    }

    static Uri KaggleUri(Dictionary<string, object> data, string suffix, string session = "")
    {
        Uri address;
        string token = StringValue(data, "token");
        if (!Uri.TryCreate(StringValue(data, "base"), UriKind.Absolute, out address) ||
            address.Scheme != "https" || !address.IsDefaultPort || address.UserInfo.Length != 0 ||
            address.Query.Length != 0 || address.Fragment.Length != 0 ||
            !KaggleHost.IsMatch(address.Host) || !KagglePath.IsMatch(address.AbsolutePath) || token.Length > 4096)
            throw new ArgumentException();

        var target = new UriBuilder(address) { Path = address.AbsolutePath + suffix };
        var query = new List<string>();
        if (token.Length != 0) query.Add("token=" + Uri.EscapeDataString(token));
        if (session.Length != 0)
        {
            target.Scheme = "wss";
            target.Port = -1;
            query.Add("session_id=" + Uri.EscapeDataString(session));
        }
        target.Query = String.Join("&", query);
        return target.Uri;
    }

    static async Task<object> GetKernels(Uri api)
    {
        using (var bounds = new CancellationTokenSource(TimeSpan.FromSeconds(12)))
        using (var response = await Http.GetAsync(api, bounds.Token))
        {
            response.EnsureSuccessStatusCode();
            return Json().DeserializeObject(await response.Content.ReadAsStringAsync());
        }
    }

    static async Task<object> Execute(Dictionary<string, object> data)
    {
        string kernel = StringValue(data, "kernelId");
        var request = Object(data["request"]);
        var header = Object(request["header"]);
        string session = StringValue(header, "session");
        string id = StringValue(header, "msg_id");
        if (!Identifier.IsMatch(kernel) || !Identifier.IsMatch(session) || !Identifier.IsMatch(id) ||
            StringValue(header, "msg_type") != "execute_request") throw new ArgumentException();

        var api = KaggleUri(data, "/api/kernels/" + kernel + "/channels", session);
        bool health = data.ContainsKey("health") && System.Object.Equals(data["health"], true);
        using (var bounds = new CancellationTokenSource(TimeSpan.FromSeconds(health ? 19 : 127)))
        using (var socket = new ClientWebSocket())
        {
            await socket.ConnectAsync(api, bounds.Token);
            var outgoing = Utf8.GetBytes(Json().Serialize(request));
            await socket.SendAsync(new ArraySegment<byte>(outgoing), WebSocketMessageType.Text, true, bounds.Token);
            var buffer = new byte[16384];
            object reply = null;
            while (socket.State == WebSocketState.Open)
            {
                using (var message = new MemoryStream())
                {
                    WebSocketReceiveResult chunk;
                    do
                    {
                        chunk = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), bounds.Token);
                        if (chunk.MessageType == WebSocketMessageType.Close) return reply;
                        if (message.Length + chunk.Count > 1024 * 1024) throw new IOException("Kaggle message exceeded limit.");
                        message.Write(buffer, 0, chunk.Count);
                    } while (!chunk.EndOfMessage);
                    if (chunk.MessageType != WebSocketMessageType.Text) continue;

                    var packet = Object(Json().DeserializeObject(Utf8.GetString(message.ToArray())));
                    if (StringValue(Object(packet["parent_header"]), "msg_id") != id) continue;
                    var content = Object(packet["content"]);
                    string type = StringValue(Object(packet["header"]), "msg_type");
                    if (type == "display_data" && Object(content["data"]).ContainsKey(ReplyMime)) reply = Object(content["data"])[ReplyMime];
                    if (type == "status" && StringValue(content, "execution_state") == "idle") return reply;
                }
            }
            return reply;
        }
    }
}
