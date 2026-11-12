using Sample.Core.Pricing;

namespace Sample.Tests.XUnit;

public class TaxRatesTests
{
    [Theory]
    [InlineData("DE", 0.19)]
    [InlineData("TR", 0.20)]
    [InlineData("US", 0.0)]
    public void ForCountry_ReturnsRate(string countryCode, double expected)
    {
        Assert.Equal((decimal)expected, TaxRates.ForCountry(countryCode));
    }
}
