[assembly: AssemblyFixture(typeof(Sample.Tests.XUnitV3.TestEnvironmentFixture))]

namespace Sample.Tests.XUnitV3;

// Assembly fixture (xUnit v3): created once for every test of the assembly.
public sealed class TestEnvironmentFixture
{
    public TestEnvironmentFixture()
    {
        Name = TestEnvironment.Describe();
    }

    public string Name { get; }
}

public static class TestEnvironment
{
    public static string Describe()
    {
        return "sample-" + Environment.ProcessorCount;
    }
}
