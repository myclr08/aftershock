using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Aftershock.Analyzer.Tests.Infrastructure;

/// <summary>
/// A real <c>aftershock-analyzer serve</c> process driven over stdio, the way the VS Code extension will drive it:
/// one JSON object per line in both directions. Every stdout line is kept so tests can check that nothing but
/// protocol messages was written.
/// </summary>
internal sealed class ServerProcess : IAsyncDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly Process _process;
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _responses = new(StringComparer.Ordinal);
    private readonly List<JsonElement> _notifications = new();
    private readonly List<JsonElement> _nullIdResponses = new();
    private readonly List<string> _lines = new();
    private readonly StringBuilder _stderr = new();
    private readonly SemaphoreSlim _signal = new(0);
    private readonly Task _reader;
    private int _nextId;

    private ServerProcess(Process process)
    {
        _process = process;
        _reader = Task.Run(ReadLoopAsync);
    }

    public IReadOnlyList<string> StdoutLines
    {
        get
        {
            lock (_lines)
            {
                return _lines.ToList();
            }
        }
    }

    public IReadOnlyList<JsonElement> Notifications
    {
        get
        {
            lock (_notifications)
            {
                return _notifications.ToList();
            }
        }
    }

    public IReadOnlyList<JsonElement> NullIdResponses
    {
        get
        {
            lock (_notifications)
            {
                return _nullIdResponses.ToList();
            }
        }
    }

    public string Stderr
    {
        get
        {
            lock (_stderr)
            {
                return _stderr.ToString();
            }
        }
    }

    public bool HasExited => _process.HasExited;

    public static ServerProcess Start(string workingDirectory, params string[] arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardInputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        startInfo.ArgumentList.Add(SamplePaths.AnalyzerAssembly);
        startInfo.ArgumentList.Add("serve");
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        startInfo.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        startInfo.Environment["DOTNET_NOLOGO"] = "1";
        startInfo.Environment["MSBUILDDISABLENODEREUSE"] = "1";
        startInfo.Environment["DOTNET_CLI_USE_MSBUILD_SERVER"] = "0";
        startInfo.Environment["GIT_TERMINAL_PROMPT"] = "0";

        var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        var server = new ServerProcess(process);
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is not null)
            {
                lock (server._stderr)
                {
                    server._stderr.AppendLine(e.Data);
                }
            }
        };

        process.Start();
        process.BeginErrorReadLine();
        server.Started.TrySetResult();
        return server;
    }

    private TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>Sends a request and returns its id (as raw JSON) without waiting.</summary>
    public string Send(string method, object? parameters = null)
    {
        var id = Interlocked.Increment(ref _nextId);
        var key = id.ToString(System.Globalization.CultureInfo.InvariantCulture);
        _responses.GetOrAdd(key, _ => new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously));
        WriteLine(Serialize(new Dictionary<string, object?> { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method, ["params"] = parameters }));
        return key;
    }

    /// <summary>Sends several messages in one write, so the server receives them back to back.</summary>
    public void SendBurst(params string[] lines)
    {
        _process.StandardInput.Write(string.Concat(lines.Select(l => l + "\n")));
        _process.StandardInput.Flush();
    }

    public string NextRequestLine(string method, object? parameters, out string id)
    {
        var number = Interlocked.Increment(ref _nextId);
        id = number.ToString(System.Globalization.CultureInfo.InvariantCulture);
        _responses.GetOrAdd(id, _ => new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously));
        return Serialize(new Dictionary<string, object?> { ["jsonrpc"] = "2.0", ["id"] = number, ["method"] = method, ["params"] = parameters });
    }

    public static string NotificationLine(string method, object? parameters) =>
        Serialize(new Dictionary<string, object?> { ["jsonrpc"] = "2.0", ["method"] = method, ["params"] = parameters });

    public void Notify(string method, object? parameters = null) => WriteLine(NotificationLine(method, parameters));

    /// <summary>Writes raw text (the caller decides the line ending).</summary>
    public void SendRaw(string text)
    {
        _process.StandardInput.Write(text);
        _process.StandardInput.Flush();
    }

    /// <summary>Expects a response with this id (for raw requests whose id the test chose).</summary>
    public void Expect(string id) =>
        _responses.GetOrAdd(id, _ => new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously));

    /// <summary>Waits for the response with <paramref name="id"/> (the whole message: result or error).</summary>
    public async Task<JsonElement> ResponseAsync(string id, TimeSpan? timeout = null)
    {
        var source = _responses.GetOrAdd(id, _ => new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously));
        var limit = timeout ?? TimeSpan.FromMinutes(2);
        if (await Task.WhenAny(source.Task, Task.Delay(limit)).ConfigureAwait(false) != source.Task)
        {
            throw new TimeoutException($"no response to request {id} within {limit}. stderr:\n{Stderr}");
        }

        return await source.Task.ConfigureAwait(false);
    }

    public async Task<JsonElement> RequestAsync(string method, object? parameters = null, TimeSpan? timeout = null) =>
        await ResponseAsync(Send(method, parameters), timeout).ConfigureAwait(false);

    /// <summary>Sends a request and returns its result; fails the test when the server answers with an error.</summary>
    public async Task<JsonElement> CallAsync(string method, object? parameters = null, TimeSpan? timeout = null)
    {
        var response = await RequestAsync(method, parameters, timeout).ConfigureAwait(false);
        if (response.TryGetProperty("error", out var error))
        {
            Assert.Fail($"{method} failed: {error}\nstderr:\n{Stderr}");
        }

        return response.GetProperty("result");
    }

    public async Task<JsonElement> WaitForNotificationAsync(Func<JsonElement, bool> predicate, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (true)
        {
            var match = Notifications.FirstOrDefault(n => predicate(n));
            if (match.ValueKind != JsonValueKind.Undefined)
            {
                return match;
            }

            var remaining = deadline - DateTime.UtcNow;
            if (remaining <= TimeSpan.Zero)
            {
                throw new TimeoutException($"notification not received within {timeout}. stderr:\n{Stderr}");
            }

            await _signal.WaitAsync(remaining < TimeSpan.FromMilliseconds(200) ? remaining : TimeSpan.FromMilliseconds(200)).ConfigureAwait(false);
        }
    }

    public void CloseInput() => _process.StandardInput.Close();

    public async Task<int> WaitForExitAsync(TimeSpan timeout)
    {
        using var cancellation = new CancellationTokenSource(timeout);
        try
        {
            await _process.WaitForExitAsync(cancellation.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw new TimeoutException($"server did not exit within {timeout}. stderr:\n{Stderr}");
        }

        // Bounded: never wait for end-of-stream forever (a grandchild could hold the pipe).
        await Task.WhenAny(_reader, Task.Delay(TimeSpan.FromSeconds(5))).ConfigureAwait(false);
        return _process.ExitCode;
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (!_process.HasExited)
            {
                _process.Kill(entireProcessTree: true);
                await _process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(false);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or TimeoutException or System.ComponentModel.Win32Exception)
        {
        }

        _process.Dispose();
    }

    private static string Serialize(object value) => JsonSerializer.Serialize(value, Json);

    private void WriteLine(string json)
    {
        _process.StandardInput.Write(json + "\n");
        _process.StandardInput.Flush();
    }

    private async Task ReadLoopAsync()
    {
        await Started.Task.ConfigureAwait(false);
        var reader = _process.StandardOutput;
        while (await reader.ReadLineAsync().ConfigureAwait(false) is { } line)
        {
            lock (_lines)
            {
                _lines.Add(line);
            }

            JsonElement message;
            try
            {
                using var document = JsonDocument.Parse(line);
                message = document.RootElement.Clone();
            }
            catch (JsonException)
            {
                continue; // reported by the stdout check of the test
            }

            if (message.TryGetProperty("id", out var id) && (message.TryGetProperty("result", out _) || message.TryGetProperty("error", out _)))
            {
                if (id.ValueKind == JsonValueKind.Null)
                {
                    lock (_notifications)
                    {
                        _nullIdResponses.Add(message);
                    }
                }
                else
                {
                    _responses.GetOrAdd(id.GetRawText(), _ => new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously)).TrySetResult(message);
                }
            }
            else
            {
                lock (_notifications)
                {
                    _notifications.Add(message);
                }
            }

            _signal.Release();
        }
    }
}
