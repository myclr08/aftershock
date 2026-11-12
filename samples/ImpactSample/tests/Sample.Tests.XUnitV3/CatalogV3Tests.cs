using Sample.Core.Catalog;

namespace Sample.Tests.XUnitV3;

// xUnit v3 shapes: IAsyncLifetime with ValueTask, collection referenced by type.
public sealed class CatalogV3Fixture : IAsyncLifetime
{
    public ProductCatalog Catalog { get; private set; } = new();

    public ValueTask InitializeAsync()
    {
        Catalog = ProductCatalog.CreateDefault();
        return ValueTask.CompletedTask;
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

[CollectionDefinition]
public sealed class CatalogCollection : ICollectionFixture<CatalogV3Fixture>
{
}

[Collection(typeof(CatalogCollection))]
public class CatalogV3Tests
{
    private readonly CatalogV3Fixture _fixture;

    public CatalogV3Tests(CatalogV3Fixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public void PriceOf_Book()
    {
        Assert.Equal(12.50m, _fixture.Catalog.PriceOf("BOOK"));
    }
}
