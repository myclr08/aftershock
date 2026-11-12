using System.Runtime.CompilerServices;
using System.Text;
using Aftershock.Analyzer.Cli;
using Aftershock.Analyzer.Server;
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
        if (parse.Options is null && parse.Serve is null)
        {
            var writer = parse.ExitCode == CliOptions.ExitSuccess ? Console.Out : Console.Error;
            await writer.WriteLineAsync(parse.Message).ConfigureAwait(false);
            return parse.ExitCode ?? CliOptions.ExitUsage;
        }

        var solution = parse.Serve?.Solution ?? parse.Options!.Solution;
        if (parse.Serve is not null)
        {
            // Child processes (the MSBuild build host, git) must not keep MSBuild nodes or build servers alive: they
            // would inherit handles and outlive the server (docs/DESIGN.md 6.1.1).
            Environment.SetEnvironmentVariable("MSBUILDDISABLENODEREUSE", "1");
            Environment.SetEnvironmentVariable("DOTNET_CLI_USE_MSBUILD_SERVER", "0");
            Environment.SetEnvironmentVariable("DOTNET_CLI_TELEMETRY_OPTOUT", "1");
            Environment.SetEnvironmentVariable("DOTNET_NOLOGO", "1");
        }

        // MSBuild must be registered before any method that touches MSBuild/workspace types is compiled.
        string msbuild;
        try
        {
            var solutionDirectory = Path.GetDirectoryName(Path.GetFullPath(solution)) ?? Environment.CurrentDirectory;
            msbuild = MSBuildSetup.Register(Directory.Exists(solutionDirectory) ? solutionDirectory : Environment.CurrentDirectory);
            await Console.Error.WriteLineAsync($"[aftershock] info: MSBuild {msbuild}").ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            await Console.Error.WriteLineAsync($"error: could not locate MSBuild / .NET SDK: {ex.Message}").ConfigureAwait(false);
            return CliOptions.ExitFatal;
        }

        if (parse.Serve is not null)
        {
            return await ServeAsync(parse.Serve, msbuild).ConfigureAwait(false);
        }

        using var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cancellation.Cancel();
        };

        return await RunAsync(parse.Options!, cancellation.Token).ConfigureAwait(false);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static Task<int> RunAsync(ImpactCommandOptions options, CancellationToken cancellationToken)
    {
        return ImpactCommand.RunAsync(options, Console.Out, Console.Error, cancellationToken);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static async Task<int> ServeAsync(ServeCommandOptions options, string msbuild)
    {
        if (!File.Exists(options.Solution))
        {
            await Console.Error.WriteLineAsync($"error: solution file not found: {Path.GetFullPath(options.Solution)}").ConfigureAwait(false);
            return CliOptions.ExitUsage;
        }

        // stdout carries protocol messages only: anything else that writes to Console.Out goes to stderr.
        var protocolOutput = Console.OpenStandardOutput();
        Console.SetOut(Console.Error);

        var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false), detectEncodingFromByteOrderMarks: false);
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            Console.Error.WriteLine($"[aftershock] warning: unobserved task exception: {e.Exception.GetBaseException().Message}");
            e.SetObserved();
        };

        var server = new AnalyzerServer(options, input, protocolOutput, Console.Error, msbuild);
        return await server.RunAsync().ConfigureAwait(false);
    }
}
