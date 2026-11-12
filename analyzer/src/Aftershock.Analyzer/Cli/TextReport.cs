using Aftershock.Analyzer.Output;

namespace Aftershock.Analyzer.Cli;

/// <summary>Human-readable summary printed when <c>--json</c> is not given.</summary>
public static class TextReport
{
    public static void Write(ImpactReport report, TextWriter writer)
    {
        writer.WriteLine($"Aftershock impact analysis ({report.Tool.Name} {report.Tool.Version})");
        writer.WriteLine($"  Solution : {report.Solution}");
        writer.WriteLine($"  Base     : {report.Base} ({Short(report.BaseCommit)})");
        writer.WriteLine();

        var ignored = report.ChangedFiles.Count(f => f.Analysis == "ignored");
        writer.WriteLine($"Changed files ({report.ChangedFiles.Count})");
        foreach (var file in report.ChangedFiles.Where(f => f.Analysis != "ignored"))
        {
            var rename = file.OldPath is null ? string.Empty : $" (from {file.OldPath})";
            var note = file.Note is null ? string.Empty : $" - {file.Note}";
            writer.WriteLine($"  {StatusLetter(file.Status)} {file.Path}{rename}  [{file.Analysis}]{note}");
        }

        if (ignored > 0)
        {
            // Documentation, build output and other files that cannot affect tests; --json lists them.
            writer.WriteLine($"  + {ignored} ignored file(s) (not source or build inputs; listed in --json output)");
        }

        writer.WriteLine();
        writer.WriteLine($"Changed symbols ({report.ChangedSymbols.Count})");
        foreach (var symbol in report.ChangedSymbols)
        {
            var detail = symbol.Detail is null ? string.Empty : $" - {symbol.Detail}";
            writer.WriteLine($"  {symbol.Symbol}  ({symbol.Kind}, {symbol.Reason}){detail}");
        }

        if (report.Fallback is { } fallback)
        {
            writer.WriteLine();
            writer.WriteLine($"Fallback: whole test projects ({fallback.TestProjects.Count})");
            foreach (var reason in fallback.Reasons)
            {
                var projects = reason.TestProjects.Count == 0 ? "no dependent test project" : string.Join(", ", reason.TestProjects.Select(Path.GetFileNameWithoutExtension));
                writer.WriteLine($"  - [{reason.Kind}] {reason.Message} -> {projects}");
            }
        }

        writer.WriteLine();
        writer.WriteLine($"Impacted tests ({report.Tests.Count})");
        foreach (var test in report.Tests)
        {
            var flags = test.Parameterized ? ", parameterized" : string.Empty;
            writer.WriteLine($"  {test.FullyQualifiedName}  [{test.Framework}{flags}]");
            writer.WriteLine($"      {string.Join(" ← ", test.Chain)}");
        }

        writer.WriteLine();
        writer.WriteLine($"Test projects ({report.TestProjects.Count})");
        foreach (var project in report.TestProjects)
        {
            var mode = project.Mode == "all" ? "all tests" : $"{project.Tests} selected test(s)";
            writer.WriteLine($"  {project.Name}: {mode}  ({project.Path})");
        }

        if (report.Diagnostics.Count > 0)
        {
            writer.WriteLine();
            writer.WriteLine($"Diagnostics ({report.Diagnostics.Count})");
            foreach (var diagnostic in report.Diagnostics)
            {
                writer.WriteLine($"  {diagnostic.Severity} [{diagnostic.Source}] {diagnostic.Message}");
            }
        }

        writer.WriteLine();
        writer.WriteLine("Durations (ms): " + string.Join(", ", report.DurationsMs.Select(d => $"{d.Key} {d.Value}")));
    }

    private static string Short(string? commit) => commit is null ? string.Empty : commit.Length > 12 ? commit[..12] : commit;

    private static string StatusLetter(string status) => status switch
    {
        "added" => "A",
        "modified" => "M",
        "deleted" => "D",
        "renamed" => "R",
        "untracked" => "?",
        _ => " ",
    };
}
