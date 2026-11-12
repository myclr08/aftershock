using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using Aftershock.Analyzer.Engine;
using Aftershock.Analyzer.Output;

namespace Aftershock.Analyzer.Server;

public sealed class ServeCommandOptions
{
    public string Solution { get; init; } = string.Empty;

    public int MaxSymbols { get; init; } = 500;

    public int TimeoutSeconds { get; init; } = 10;

    public IReadOnlyList<string> FallbackGlobs { get; init; } = ImpactOptions.DefaultFallbackGlobs;

    public bool Verbose { get; init; }
}

/// <summary>
/// The long-running analyzer: newline-delimited JSON-RPC 2.0 over stdio around a <see cref="WorkspaceSession"/>.
/// The reader loop only parses and dispatches; every request runs on its own task, so <c>$/cancelRequest</c> and
/// supersede work while an analysis runs. Analyses are serialized by the session. A failing request never stops the
/// server: it is answered with an error response.
/// </summary>
public sealed class AnalyzerServer
{
    private static readonly string[] LogLevels = { "debug", "info", "warning", "error" };

    private readonly ServeCommandOptions _options;
    private readonly TextReader _input;
    private readonly TextWriter _stderr;
    private readonly JsonRpcChannel _channel;
    private readonly string _msbuild;
    private readonly ConcurrentDictionary<string, RequestState> _requests = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _requestedFiles = WorkspaceSession.CreateRequestedSet();
    private readonly CancellationTokenSource _stop = new();
    private readonly Stopwatch _uptime = Stopwatch.StartNew();
    private readonly object _loadGate = new();
    private readonly AnalysisLog _serverLog;

    private Task<WorkspaceSession>? _loadTask;
    private string? _loadError;
    private AnalysisSettings _defaults;
    private volatile int _notifyLevel = 1; // index into LogLevels; 4 = off
    private volatile bool _initializeCalled;
    private volatile bool _shutdownRequested;
    private int _exitCode;
    private long _served;

    public AnalyzerServer(ServeCommandOptions options, TextReader input, Stream output, TextWriter stderr, string msbuild)
    {
        _options = options;
        _input = input;
        _stderr = stderr;
        _msbuild = msbuild;
        _channel = new JsonRpcChannel(output);
        _channel.WriteFailed += ex =>
        {
            _stderr.WriteLine($"[aftershock] error: cannot write to stdout ({ex.Message}); stopping");
            _stop.Cancel();
        };
        _defaults = new AnalysisSettings(options.MaxSymbols, options.TimeoutSeconds, options.FallbackGlobs);
        _serverLog = CreateLog(null);
    }

    private bool Verbose => _options.Verbose || _notifyLevel == 0;

    /// <summary>Runs until <c>exit</c>, end of input, or a broken output. Returns the process exit code.</summary>
    public async Task<int> RunAsync()
    {
        _serverLog.Info($"server mode, protocol {ServerProtocol.ProtocolVersion}, solution {_options.Solution}");
        StartLoad();
        var stopped = Task.Delay(Timeout.Infinite, _stop.Token);
        while (true)
        {
            var read = _input.ReadLineAsync();
            if (await Task.WhenAny(read, stopped).ConfigureAwait(false) == stopped)
            {
                break;
            }

            string? line;
            try
            {
                line = await read.ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException)
            {
                _serverLog.Warning("server", $"cannot read stdin ({ex.Message}); stopping");
                break;
            }

            if (line is null)
            {
                _serverLog.Info("end of input; stopping");
                break;
            }

            line = line.TrimStart('﻿');
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            try
            {
                if (HandleLine(line))
                {
                    break;
                }
            }
            catch (Exception ex)
            {
                // Never let one message stop the server.
                _serverLog.Error("server", $"unexpected failure while dispatching a message: {ex}");
            }
        }

        await StopAsync().ConfigureAwait(false);
        return _exitCode;
    }

    /// <summary>Handles one line; returns true when the server must stop (exit notification).</summary>
    private bool HandleLine(string line)
    {
        var (message, errorId, errorCode, errorMessage) = JsonRpcChannel.Parse(line);
        if (message is null)
        {
            if (errorCode != 0)
            {
                _serverLog.Warning("protocol", errorMessage!);
                _channel.SendError(errorId, errorCode, errorMessage!);
            }

            return false;
        }

        if (message.IsNotification)
        {
            return HandleNotification(message);
        }

        Dispatch(message);
        return false;
    }

    private bool HandleNotification(IncomingMessage message)
    {
        switch (message.Method)
        {
            case "exit":
                _exitCode = _shutdownRequested ? 0 : 1;
                _serverLog.Info($"exit notification received{(_shutdownRequested ? string.Empty : " without shutdown")}");
                return true;
            case "$/cancelRequest":
                if (message.Params is { } p && p.TryGetProperty("id", out var id) && id.ValueKind is JsonValueKind.Number or JsonValueKind.String
                    && _requests.TryGetValue(id.GetRawText(), out var target))
                {
                    target.Cancel("cancelled", null);
                }

                return false;
            default:
                _serverLog.Debug($"ignored notification '{message.Method}'");
                return false;
        }
    }

    private void Dispatch(IncomingMessage message)
    {
        var id = message.Id!;
        if (_shutdownRequested)
        {
            _channel.SendError(id, JsonRpcErrorCodes.InvalidRequest, "the server is shutting down");
            return;
        }

        if (message.Method is not ("initialize" or "impact" or "impactSinceBase" or "reload" or "status" or "shutdown"))
        {
            _channel.SendError(id, JsonRpcErrorCodes.MethodNotFound, $"unknown method '{message.Method}'");
            return;
        }

        if (!_initializeCalled && message.Method is not ("initialize" or "status" or "shutdown"))
        {
            _channel.SendError(id, JsonRpcErrorCodes.ServerNotInitialized, "send 'initialize' first");
            return;
        }

        if (message.Method == "initialize" && _initializeCalled)
        {
            _channel.SendError(id, JsonRpcErrorCodes.InvalidRequest, "initialize was already called");
            return;
        }

        if (_requests.ContainsKey(id))
        {
            _channel.SendError(id, JsonRpcErrorCodes.InvalidRequest, $"a request with id {id} is still in progress");
            return;
        }

        var state = new RequestState(this, message, CancellationTokenSource.CreateLinkedTokenSource(_stop.Token));
        try
        {
            if (message.Method == "initialize")
            {
                _initializeCalled = true;
            }

            if (message.Method is "impact" or "impactSinceBase")
            {
                state.Files = ParseFiles(message.Params, required: message.Method == "impact");
                if (message.Method == "impact")
                {
                    // Registered on arrival: if this request is superseded before it runs, the next one covers its files.
                    foreach (var file in state.Files!)
                    {
                        _requestedFiles[file] = 0;
                    }
                }

                if (Params.Bool(message.Params, "supersede") ?? true)
                {
                    foreach (var other in _requests.Values.Where(r => r.Method == message.Method))
                    {
                        other.Cancel("superseded", state.IdElement);
                    }
                }
            }
        }
        catch (SessionException ex)
        {
            state.Dispose();
            _channel.SendError(id, ex.Code, ex.Message, ex.ErrorData);
            return;
        }

        _requests[id] = state;
        state.Task = Task.Run(() => RunAsync(state));
    }

    private async Task RunAsync(RequestState state)
    {
        var watch = Stopwatch.StartNew();
        try
        {
            object? result = state.Method switch
            {
                "initialize" => await InitializeAsync(state).ConfigureAwait(false),
                "impact" => await ImpactAsync(state).ConfigureAwait(false),
                "impactSinceBase" => await ImpactSinceBaseAsync(state).ConfigureAwait(false),
                "reload" => await ReloadAsync(state).ConfigureAwait(false),
                "status" => Status(),
                "shutdown" => Shutdown(state),
                _ => throw new SessionException(JsonRpcErrorCodes.MethodNotFound, $"unknown method '{state.Method}'"),
            };
            _channel.SendResult(state.Id, result);
        }
        catch (OperationCanceledException) when (state.Token.IsCancellationRequested)
        {
            if (state.Method == "initialize")
            {
                // A cancelled initialize did not happen: the client may send it again.
                _initializeCalled = false;
            }

            var reason = state.CancelReason ?? (_stop.IsCancellationRequested ? "shutdown" : "cancelled");
            _serverLog.Info($"{state.Method} {state.Id} {reason} after {watch.ElapsedMilliseconds} ms");
            _channel.SendError(state.Id, JsonRpcErrorCodes.RequestCancelled, $"request {reason}", new CancelledData(reason, state.CancelledBy));
        }
        catch (SessionException ex)
        {
            _serverLog.Warning("server", $"{state.Method} {state.Id}: {ex.Message}");
            _channel.SendError(state.Id, ex.Code, ex.Message, ex.ErrorData);
        }
        catch (Exception ex)
        {
            _serverLog.Error("server", $"{state.Method} {state.Id} failed: {ex}");
            _channel.SendError(state.Id, JsonRpcErrorCodes.InternalError, $"{state.Method} failed: {ex.Message}");
        }
        finally
        {
            _requests.TryRemove(state.Id, out _);
            Interlocked.Increment(ref _served);
            state.Dispose();
        }
    }

    private async Task<InitializeResult> InitializeAsync(RequestState state)
    {
        var p = state.Params;
        if (Params.String(p, "logLevel") is { } level)
        {
            var index = Array.IndexOf(LogLevels, level);
            _notifyLevel = level == "off" ? LogLevels.Length : index >= 0 ? index : throw new SessionException(JsonRpcErrorCodes.InvalidParams, "logLevel must be debug, info, warning, error or off");
        }

        if (Params.String(p, "solution") is { } solution && !PathUtil.PathEquals(PathUtil.Normalize(solution), PathUtil.Normalize(_options.Solution)))
        {
            throw new SessionException(JsonRpcErrorCodes.InvalidParams, $"this server was started for {_options.Solution}; start another server for {solution}");
        }

        _defaults = Settings(p, _defaults);
        var session = await RequireSessionAsync(state.Token).ConfigureAwait(false);
        return new InitializeResult
        {
            Solution = session.SolutionPath,
            RepositoryRoot = session.RepositoryRoot,
            Msbuild = _msbuild,
            Workspace = session.Info,
            Options = new AnalysisOptionsInfo(_defaults.MaxSymbols, _defaults.TimeoutSeconds, _defaults.FallbackGlobs),
            Capabilities = new CapabilitiesInfo(session.RepositoryRoot is not null, true, true),
            Diagnostics = session.LoadDiagnostics.ToList(),
        };
    }

    private async Task<ImpactReport> ImpactAsync(RequestState state)
    {
        var session = await RequireSessionAsync(state.Token).ConfigureAwait(false);
        var report = await session.ImpactAsync(state.Files!, Settings(state.Params, _defaults), state, state.Token).ConfigureAwait(false);
        LogSummary(state, report);
        return report;
    }

    private async Task<ImpactReport> ImpactSinceBaseAsync(RequestState state)
    {
        var baseRef = Params.String(state.Params, "base");
        if (string.IsNullOrWhiteSpace(baseRef))
        {
            throw new SessionException(JsonRpcErrorCodes.InvalidParams, "'base' (a git revision) is required");
        }

        var mergeBase = Params.Bool(state.Params, "mergeBase") ?? true;
        var session = await RequireSessionAsync(state.Token).ConfigureAwait(false);
        var report = await session.ImpactSinceBaseAsync(baseRef, mergeBase, state.Files, Settings(state.Params, _defaults), state, state.Token).ConfigureAwait(false);
        LogSummary(state, report);
        return report;
    }

    private async Task<ReloadOutcome> ReloadAsync(RequestState state)
    {
        WorkspaceSession? session = null;
        try
        {
            session = await RequireSessionAsync(state.Token).ConfigureAwait(false);
        }
        catch (SessionException ex) when (ex.Code == JsonRpcErrorCodes.WorkspaceUnavailable)
        {
            // The first load failed: try again from scratch.
            lock (_loadGate)
            {
                _loadTask = null;
            }

            StartLoad();
            var watch = Stopwatch.StartNew();
            var fresh = await RequireSessionAsync(state.Token).ConfigureAwait(false);
            return new ReloadOutcome { Success = true, Reason = "requested by the client", DurationMs = watch.ElapsedMilliseconds, Workspace = fresh.Info, Diagnostics = fresh.LoadDiagnostics.ToList() };
        }

        return await session.ReloadAsync("requested by the client").WaitAsync(state.Token).ConfigureAwait(false);
    }

    private StatusResult Status()
    {
        Task<WorkspaceSession>? load;
        lock (_loadGate)
        {
            load = _loadTask;
        }

        var session = load is { IsCompletedSuccessfully: true } ? load.Result : null;
        var status = session?.GetStatus();
        var state = _shutdownRequested ? "shuttingDown" : session is not null ? "ready" : load is { IsCompleted: true } ? "failed" : "loading";
        return new StatusResult
        {
            State = state,
            Initialized = _initializeCalled,
            Solution = session?.SolutionPath ?? _options.Solution,
            RepositoryRoot = session?.RepositoryRoot,
            UptimeMs = _uptime.ElapsedMilliseconds,
            RequestsServed = Interlocked.Read(ref _served),
            InFlight = _requests.Values.Select(r => new InFlightRequest(r.IdElement, r.Method)).ToList(),
            Options = new AnalysisOptionsInfo(_defaults.MaxSymbols, _defaults.TimeoutSeconds, _defaults.FallbackGlobs),
            Workspace = status?.Workspace,
            Reloading = status?.Reloading ?? false,
            AllProjectsDirty = status?.AllProjectsDirty ?? false,
            DirtyProjects = status?.DirtyProjects ?? new List<string>(),
            PendingFiles = status?.PendingFiles ?? _requestedFiles.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList(),
            Cache = status is null ? null : new CacheInfo(status.CachedSymbols, status.CacheSearches, status.CacheScopedSearches, status.CacheHits),
            LoadError = _loadError,
        };
    }

    private object? Shutdown(RequestState state)
    {
        _shutdownRequested = true;
        foreach (var other in _requests.Values.Where(r => r != state))
        {
            other.Cancel("shutdown", null);
        }

        _serverLog.Info("shutdown requested");
        return null;
    }

    private void StartLoad()
    {
        lock (_loadGate)
        {
            if (_loadTask is not null)
            {
                return;
            }

            _loadError = null;
            _loadTask = Task.Run(async () =>
            {
                var watch = Stopwatch.StartNew();
                SendProgress(null, null, "load", _options.Solution);
                try
                {
                    var session = await WorkspaceSession.OpenAsync(_options.Solution, () => CreateLog(null), _requestedFiles, _stop.Token).ConfigureAwait(false);
                    session.ReloadStarted += reason => SendProgress(null, null, "reload", reason);
                    session.Reloaded += outcome => _channel.SendNotification("workspaceReloaded", outcome);
                    _serverLog.Info($"workspace loaded in {watch.ElapsedMilliseconds} ms: {session.Info.Projects} project(s), {session.Info.Documents} document(s), {session.Info.TestProjects.Count} test project(s)");
                    _ = WarmUpAsync(session);
                    return session;
                }
                catch (Exception ex) when (ex is not OperationCanceledException || !_stop.IsCancellationRequested)
                {
                    _loadError = ex.Message;
                    _serverLog.Error("workspace", $"loading {_options.Solution} failed: {ex.Message}");
                    throw;
                }
            });
        }
    }

    private async Task WarmUpAsync(WorkspaceSession session)
    {
        try
        {
            SendProgress(null, null, "warmUp", null);
            var ms = await session.WarmUpAsync(_stop.Token).ConfigureAwait(false);
            _serverLog.Info($"warm-up done in {ms} ms");
            SendProgress(null, null, "ready", null);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            _serverLog.Warning("workspace", $"warm-up failed: {ex.Message}");
        }
    }

    private async Task<WorkspaceSession> RequireSessionAsync(CancellationToken cancellationToken)
    {
        Task<WorkspaceSession>? load;
        lock (_loadGate)
        {
            load = _loadTask;
        }

        if (load is null)
        {
            throw new SessionException(JsonRpcErrorCodes.WorkspaceUnavailable, "the workspace is not loaded");
        }

        try
        {
            return await load.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            var message = ex is SessionException ? ex.Message : $"the workspace could not be loaded: {ex.Message}";
            throw new SessionException(JsonRpcErrorCodes.WorkspaceUnavailable, message);
        }
    }

    private async Task StopAsync()
    {
        _shutdownRequested = true;
        foreach (var request in _requests.Values)
        {
            request.Cancel("shutdown", null);
        }

        _stop.Cancel();
        var pending = _requests.Values.Select(r => r.Task).OfType<Task>().ToArray();
        await Task.WhenAny(Task.WhenAll(pending), Task.Delay(TimeSpan.FromSeconds(5))).ConfigureAwait(false);

        Task<WorkspaceSession>? load;
        lock (_loadGate)
        {
            load = _loadTask;
        }

        if (load is not null)
        {
            await Task.WhenAny(load, Task.Delay(TimeSpan.FromSeconds(5))).ConfigureAwait(false);
            if (load.IsCompletedSuccessfully)
            {
                load.Result.Dispose();
            }
        }

        _serverLog.Info($"stopped after {_uptime.ElapsedMilliseconds} ms, {Interlocked.Read(ref _served)} request(s) served");
        await _channel.CompleteAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
    }

    private void LogSummary(RequestState state, ImpactReport report)
    {
        var fallback = report.Fallback is null ? "none" : string.Join(",", report.Fallback.Reasons.Select(r => r.Kind).Distinct());
        var durations = string.Join(", ", report.DurationsMs.Select(d => $"{d.Key}={d.Value}"));
        _serverLog.Info(
            $"{state.Method} {state.Id}: {report.ChangedFiles.Count} changed file(s), {report.ChangedSymbols.Count} symbol(s), {report.Tests.Count} test(s), fallback {fallback}; " +
            $"visited={report.Stats.VisitedSymbols}, searches={report.Stats.ReferenceSearches}, scoped={report.Stats.ScopedSearches}, cacheHits={report.Stats.CacheHits}; durations (ms): {durations}");
    }

    private AnalysisLog CreateLog(RequestState? request) =>
        new(_stderr, Verbose, (level, message) => SendLog(level, message, request?.IdElement));

    private void SendLog(string level, string message, JsonElement? id)
    {
        var index = Array.IndexOf(LogLevels, level);
        if (index >= 0 && index >= _notifyLevel)
        {
            _channel.SendNotification("log", new LogParams(level, message, id));
        }
    }

    private void SendProgress(JsonElement? id, string? method, string phase, string? message)
    {
        _channel.SendNotification("progress", new ProgressParams(id, method, phase, message));
    }

    private AnalysisSettings Settings(JsonElement? parameters, AnalysisSettings defaults)
    {
        if (parameters is not { } p || !p.TryGetProperty("options", out var options) || options.ValueKind == JsonValueKind.Null)
        {
            return defaults;
        }

        if (options.ValueKind != JsonValueKind.Object)
        {
            throw new SessionException(JsonRpcErrorCodes.InvalidParams, "'options' must be an object");
        }

        var maxSymbols = Params.NonNegativeInt(options, "maxSymbols") ?? defaults.MaxSymbols;
        var timeout = Params.NonNegativeInt(options, "timeoutSeconds") ?? defaults.TimeoutSeconds;
        var globs = Params.StringArray(options, "fallbackGlobs") ?? defaults.FallbackGlobs;
        return new AnalysisSettings(maxSymbols, timeout, globs);
    }

    private IReadOnlyList<string>? ParseFiles(JsonElement? parameters, bool required)
    {
        var files = Params.StringArray(parameters, "files");
        if (files is null)
        {
            return required ? throw new SessionException(JsonRpcErrorCodes.InvalidParams, "'files' (an array of file paths) is required") : null;
        }

        var directory = Path.GetDirectoryName(PathUtil.Normalize(_options.Solution))!;
        var result = new List<string>(files.Count);
        foreach (var file in files)
        {
            try
            {
                var path = file.StartsWith("file:", StringComparison.OrdinalIgnoreCase) ? new Uri(file).LocalPath : file;
                result.Add(PathUtil.Normalize(Path.IsPathRooted(path) ? path : Path.Combine(directory, path)));
            }
            catch (Exception ex) when (ex is ArgumentException or UriFormatException or NotSupportedException or PathTooLongException)
            {
                throw new SessionException(JsonRpcErrorCodes.InvalidParams, $"invalid file path '{file}': {ex.Message}");
            }
        }

        return result;
    }

    /// <summary>One request in progress; also the <see cref="IRequestContext"/> handed to the session.</summary>
    private sealed class RequestState : IRequestContext, IDisposable
    {
        private readonly AnalyzerServer _server;
        private readonly CancellationTokenSource _cancellation;
        private readonly object _gate = new();
        private bool _committed;

        public RequestState(AnalyzerServer server, IncomingMessage message, CancellationTokenSource cancellation)
        {
            _server = server;
            _cancellation = cancellation;
            Id = message.Id!;
            Method = message.Method;
            Params = message.Params;
            using var document = JsonDocument.Parse(Id);
            IdElement = document.RootElement.Clone();
        }

        public string Id { get; }

        public JsonElement IdElement { get; }

        public string Method { get; }

        public JsonElement? Params { get; }

        public IReadOnlyList<string>? Files { get; set; }

        public Task? Task { get; set; }

        public CancellationToken Token => _cancellation.Token;

        public string? CancelReason { get; private set; }

        public JsonElement? CancelledBy { get; private set; }

        /// <summary>Cancels the request unless it has already committed its result.</summary>
        public void Cancel(string reason, JsonElement? by)
        {
            lock (_gate)
            {
                if (_committed || CancelReason is not null)
                {
                    return;
                }

                CancelReason = reason;
                CancelledBy = by;
            }

            try
            {
                _cancellation.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
        }

        public void Phase(string phase) => _server.SendProgress(IdElement, Method, phase, null);

        public AnalysisLog CreateLog() => _server.CreateLog(this);

        public bool TryCommit()
        {
            lock (_gate)
            {
                if (CancelReason is not null || _cancellation.IsCancellationRequested)
                {
                    return false;
                }

                _committed = true;
                return true;
            }
        }

        public void Dispose() => _cancellation.Dispose();
    }

    /// <summary>Lenient readers for named parameters; type errors become InvalidParams.</summary>
    private static class Params
    {
        public static string? String(JsonElement? parameters, string name)
        {
            if (parameters is not { } p || !p.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null)
            {
                return null;
            }

            return value.ValueKind == JsonValueKind.String ? value.GetString() : throw Invalid(name, "a string");
        }

        public static bool? Bool(JsonElement? parameters, string name)
        {
            if (parameters is not { } p || !p.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null)
            {
                return null;
            }

            return value.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => throw Invalid(name, "a boolean"),
            };
        }

        public static int? NonNegativeInt(JsonElement element, string name)
        {
            if (!element.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null)
            {
                return null;
            }

            return value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) && number >= 0 ? number : throw Invalid(name, "a non-negative integer");
        }

        public static IReadOnlyList<string>? StringArray(JsonElement? parameters, string name)
        {
            if (parameters is not { } p || !p.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null)
            {
                return null;
            }

            if (value.ValueKind != JsonValueKind.Array || value.EnumerateArray().Any(e => e.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(e.GetString())))
            {
                throw Invalid(name, "an array of non-empty strings");
            }

            return value.EnumerateArray().Select(e => e.GetString()!).ToList();
        }

        private static SessionException Invalid(string name, string expected) =>
            new(JsonRpcErrorCodes.InvalidParams, $"'{name}' must be {expected}");
    }
}
