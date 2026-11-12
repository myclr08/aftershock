using System.Runtime.CompilerServices;
using System.Text;
using Aftershock.Analyzer.Cli;
using Aftershock.Analyzer.Workspace;

namespace Aftershock.Analyzer;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        }
        catch (IOException)
        {
            // No console attached; stdout is a pipe and already byte oriented.
        }

        var parse = CliOptions.Parse(args);
        if (parse.Options is null)
        {
            var writer = parse.ExitCode == CliOptions.ExitSuccess ? Console.Out : Console.Error;
            await writer.WriteLineAsync(parse.Message).ConfigureAwait(false);
            return parse.ExitCode ?? CliOptions.ExitUsage;
        }

        // MSBuild must be registered before any method that touches MSBuild/workspace types is compiled.
        try
        {
            var solutionDirectory = Path.GetDirectoryName(Path.GetFullPath(parse.Options.Solution)) ?? Environment.CurrentDirectory;
            var msbuild = MSBuildSetup.Register(Directory.Exists(solutionDirectory) ? solutionDirectory : Environment.CurrentDirectory);
            await Console.Error.WriteLineAsync($"[aftershock] info: MSBuild {msbuild}").ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            await Console.Error.WriteLineAsync($"error: could not locate MSBuild / .NET SDK: {ex.Message}").ConfigureAwait(false);
            return CliOptions.ExitFatal;
        }

        using var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cancellation.Cancel();
        };

        return await RunAsync(parse.Options, cancellation.Token).ConfigureAwait(false);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static Task<int> RunAsync(ImpactCommandOptions options, CancellationToken cancellationToken)
    {
        return ImpactCommand.RunAsync(options, Console.Out, Console.Error, cancellationToken);
    }
}
