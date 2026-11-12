using Sample.Core.Pricing;

namespace Sample.Tests.XUnit;

public class MoneyTests
{
    [Fact]
    public void Add_SameCurrency_SumsAmounts()
    {
        var sum = new Money(1.5m, "EUR") + new Money(2m, "EUR");

        Assert.Equal(new Money(3.5m, "EUR"), sum);
    }
}
