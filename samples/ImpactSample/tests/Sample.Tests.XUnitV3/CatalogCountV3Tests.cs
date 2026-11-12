namespace Sample.Tests.XUnitV3;

// Generic collection attribute (xUnit v3).
[Collection<CatalogCollection>]
public class CatalogCountV3Tests
{
    private readonly CatalogV3Fixture _fixture;

    public CatalogCountV3Tests(CatalogV3Fixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public void Count_IsThree()
    {
        Assert.Equal(3, _fixture.Catalog.Count);
    }
}
