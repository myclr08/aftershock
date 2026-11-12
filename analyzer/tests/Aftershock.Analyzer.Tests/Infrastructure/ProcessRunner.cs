using System.Diagnostics;
using System.Text;

namespace Aftershock.Analyzer.Tests.Infrastructure;

internal sealed record ProcessResult(int ExitCode, string Output, string Error);

internal static class ProcessRunner
{
    public static ProcessResult Run(string fileName, string workingDirectory, params string[] arguments)
    {
        var startInfo = new ProcessStartInfo(fileName)
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        startInfo.Environment["GIT_TERMINAL_PROMPT"] = "0";
        startInfo.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        startInfo.Environment["DOTNET_NOLOGO"] = "1";

        // Reused MSBuild nodes and build servers inherit the redirected pipes and keep them open after the
        // command exits, which would make reading the output hang forever.
        startInfo.Environment["MSBUILDDISABLENODEREUSE"] = "1";
        startInfo.Environment["DOTNET_CLI_USE_MSBUILD_SERVER"] = "0";
        startInfo.Environment["UseSharedCompilation"] = "false";

        using var process = Process.Start(startInfo)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(TimeSpan.FromMinutes(5)))
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException($"{fileName} {string.Join(' ', arguments)} timed out");
        }

        // Do not wait forever for EOF: a grandchild process may still hold the pipes.
        Task.WhenAll(output, error).Wait(TimeSpan.FromSeconds(30));
        return new ProcessResult(
            process.ExitCode,
            output.IsCompletedSuccessfully ? output.Result : string.Empty,
            error.IsCompletedSuccessfully ? error.Result : string.Empty);
    }

    public static ProcessResult Git(string workingDirectory, params string[] arguments)
    {
        var args = new List<string> { "-c", "user.name=Aftershock Tests", "-c", "user.email=tests@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false" };
        args.AddRange(arguments);
        var result = Run("git", workingDirectory, args.ToArray());
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException($"git {string.Join(' ', arguments)} failed: {result.Error}");
        }

        return result;
    }
}
