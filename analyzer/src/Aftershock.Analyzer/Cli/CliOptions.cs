using System.Globalization;
using Aftershock.Analyzer.Engine;

namespace Aftershock.Analyzer.Cli;

public sealed class ImpactCommandOptions
{
    public string Solution { get; init; } = string.Empty;

    public string Base { get; init; } = string.Empty;

    public bool Json { get; init; }

    public bool Verbose { get; init; }

    public int MaxSymbols { get; init; } = 500;

    public int TimeoutSeconds { get; init; } = 10;

    public IReadOnlyList<string> FallbackGlobs { get; init; } = ImpactOptions.DefaultFallbackGlobs;
}

public sealed record ParseResult(ImpactCommandOptions? Options, int? ExitCode, string? Message);

/// <summary>Hand-written argument parser (no dependency, predictable on every platform).</summary>
public static class CliOptions
{
    public const int ExitSuccess = 0;
    public const int ExitFatal = 1;
    public const int ExitUsage = 2;

    public const string Usage = """
        Usage:
          aftershock-analyzer impact --solution <path.sln> --base <git-ref> [options]

        Finds the test methods affected by the changes between <git-ref> and the working tree
        (staged, unstaged and untracked files).

        Options:
          --solution <path>         Solution file (.sln or .slnx) to analyze. Required.
          --base <git-ref>          Commit, branch or tag to compare the working tree with. Required.
          --json                    Write the JSON report to stdout (otherwise a text summary).
          --max-symbols <n>         Symbols visited per changed file before falling back (default 500, 0 = no limit).
          --timeout-seconds <n>     Time budget of the reference search (default 10, 0 = no limit).
          --fallback-glob <glob>    Files that trigger a fallback to whole test projects. Repeatable;
                                    replaces the default '**/appsettings*.json'.
          --verbose                 More detail on stderr.
          -h, --help                Show this help.
          --version                 Show the version.

        Exit codes: 0 success (including fallback results), 1 fatal error, 2 usage error.
        """;

    public static ParseResult Parse(IReadOnlyList<string> args)
    {
        if (args.Count == 0)
        {
            return new ParseResult(null, ExitUsage, Usage);
        }

        if (args[0] is "-h" or "--help" or "help")
        {
            return new ParseResult(null, ExitSuccess, Usage);
        }

        if (args[0] == "--version")
        {
            return new ParseResult(null, ExitSuccess, Output.ToolInfo.Current);
        }

        if (args[0] != "impact")
        {
            return new ParseResult(null, ExitUsage, $"unknown command '{args[0]}'\n\n{Usage}");
        }

        string? solution = null;
        string? baseRef = null;
        var json = false;
        var verbose = false;
        var maxSymbols = 500;
        var timeout = 10;
        var globs = new List<string>();

        for (var i = 1; i < args.Count; i++)
        {
            var arg = args[i];
            string? inlineValue = null;
            var eq = arg.StartsWith("--", StringComparison.Ordinal) ? arg.IndexOf('=') : -1;
            if (eq > 0)
            {
                inlineValue = arg[(eq + 1)..];
                arg = arg[..eq];
            }

            string? Value()
            {
                if (inlineValue is not null)
                {
                    return inlineValue;
                }

                return i + 1 < args.Count ? args[++i] : null;
            }

            switch (arg)
            {
                case "-h":
                case "--help":
                    return new ParseResult(null, ExitSuccess, Usage);
                case "--solution":
                    solution = Value();
                    if (string.IsNullOrWhiteSpace(solution))
                    {
                        return Error("--solution needs a value");
                    }

                    break;
                case "--base":
                    baseRef = Value();
                    if (string.IsNullOrWhiteSpace(baseRef))
                    {
                        return Error("--base needs a value");
                    }

                    break;
                case "--json":
                    json = true;
                    break;
                case "--verbose":
                    verbose = true;
                    break;
                case "--max-symbols":
                    if (!TryInt(Value(), out maxSymbols))
                    {
                        return Error("--max-symbols needs a non-negative integer");
                    }

                    break;
                case "--timeout-seconds":
                    if (!TryInt(Value(), out timeout))
                    {
                        return Error("--timeout-seconds needs a non-negative integer");
                    }

                    break;
                case "--fallback-glob":
                    var glob = Value();
                    if (string.IsNullOrWhiteSpace(glob))
                    {
                        return Error("--fallback-glob needs a value");
                    }

                    globs.Add(glob);
                    break;
                default:
                    return Error($"unknown option '{args[i]}'");
            }
        }

        if (solution is null)
        {
            return Error("--solution is required");
        }

        if (baseRef is null)
        {
            return Error("--base is required");
        }

        return new ParseResult(
            new ImpactCommandOptions
            {
                Solution = solution,
                Base = baseRef,
                Json = json,
                Verbose = verbose,
                MaxSymbols = maxSymbols,
                TimeoutSeconds = timeout,
                FallbackGlobs = globs.Count > 0 ? globs : ImpactOptions.DefaultFallbackGlobs,
            },
            null,
            null);

        static ParseResult Error(string message) => new(null, ExitUsage, $"error: {message}\n\n{Usage}");

        static bool TryInt(string? text, out int value) =>
            int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) && value >= 0;
    }
}
