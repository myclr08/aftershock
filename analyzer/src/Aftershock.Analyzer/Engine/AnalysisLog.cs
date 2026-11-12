using System.Collections.Concurrent;
using Aftershock.Analyzer.Output;

namespace Aftershock.Analyzer.Engine;

/// <summary>
/// Collects diagnostics for the JSON report and mirrors every message to a text sink (stderr in the CLI) and to an
/// optional listener (the server forwards messages as <c>log</c> notifications).
/// Nothing is swallowed: warnings and errors always end up in <see cref="Diagnostics"/>.
/// </summary>
public sealed class AnalysisLog
{
    private readonly TextWriter? _sink;
    private readonly bool _verbose;
    private readonly Action<string, string>? _listener;
    private readonly ConcurrentQueue<DiagnosticReport> _diagnostics = new();
    private readonly object _writeLock = new();

    /// <param name="sink">Text sink; every line is prefixed with <c>[aftershock] level:</c>.</param>
    /// <param name="verbose">Whether debug messages are written.</param>
    /// <param name="listener">Receives (level, message) for every written message; must not throw.</param>
    public AnalysisLog(TextWriter? sink, bool verbose = false, Action<string, string>? listener = null)
    {
        _sink = sink;
        _verbose = verbose;
        _listener = listener;
    }

    public bool Verbose => _verbose;

    public IReadOnlyList<DiagnosticReport> Diagnostics => _diagnostics.ToArray();

    public void Debug(string message)
    {
        if (_verbose)
        {
            Write("debug", message);
        }
    }

    public void Info(string message) => Write("info", message);

    public void Warning(string source, string message)
    {
        _diagnostics.Enqueue(new DiagnosticReport("warning", source, message));
        Write("warning", $"{source}: {message}");
    }

    public void Error(string source, string message)
    {
        _diagnostics.Enqueue(new DiagnosticReport("error", source, message));
        Write("error", $"{source}: {message}");
    }

    private void Write(string level, string message)
    {
        if (_sink is not null)
        {
            lock (_writeLock)
            {
                _sink.WriteLine($"[aftershock] {level}: {message}");
            }
        }

        _listener?.Invoke(level, message);
    }
}
