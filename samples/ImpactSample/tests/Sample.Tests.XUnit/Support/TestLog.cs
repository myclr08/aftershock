using Xunit.Abstractions;

namespace Sample.Tests.XUnit.Support;

// Small helper built from the injected ITestOutputHelper.
public sealed class TestLog
{
    private readonly ITestOutputHelper _output;

    public TestLog(ITestOutputHelper output)
    {
        _output = output;
    }

    public void Write(string message)
    {
        _output.WriteLine("[test] " + message);
    }
}
