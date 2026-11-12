using Sample.Core.Orders;
using Sample.Tests.XUnit.Support;

namespace Sample.Tests.XUnit;

public sealed class SeededRepositoryFixture : IDisposable
{
    public SeededRepositoryFixture()
    {
        Seed = SampleOrders.Create();
        Repository = new InMemoryOrderRepository(Seed);
    }

    public IReadOnlyList<Order> Seed { get; }

    public InMemoryOrderRepository Repository { get; }

    public void Dispose()
    {
    }
}

[CollectionDefinition("Seeded repository")]
public sealed class SeededRepositoryCollection : ICollectionFixture<SeededRepositoryFixture>
{
}

[Collection("Seeded repository")]
public class RepositoryLookupTests
{
    private readonly SeededRepositoryFixture _fixture;

    public RepositoryLookupTests(SeededRepositoryFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public void Find_ReturnsSeededOrder()
    {
        var first = _fixture.Seed[0];
        Assert.Same(first, _fixture.Repository.Find(first.Id));
    }

    [Fact]
    public void Find_Unknown_ReturnsNull()
    {
        Assert.Null(_fixture.Repository.Find(Guid.NewGuid()));
    }
}

[Collection("Seeded repository")]
public class RepositoryCountTests
{
    private readonly SeededRepositoryFixture _fixture;

    public RepositoryCountTests(SeededRepositoryFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public void Count_MatchesSeed()
    {
        Assert.Equal(_fixture.Seed.Count, _fixture.Repository.Count);
    }
}
