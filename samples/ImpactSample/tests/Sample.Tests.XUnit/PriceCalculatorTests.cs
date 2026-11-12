using Sample.Core.Orders;
using Sample.Core.Pricing;
using Sample.Tests.XUnit.Support;
using Xunit.Abstractions;

namespace Sample.Tests.XUnit;

public class PriceCalculatorTests
{
    private readonly PriceCalculator _calculator = new();
    private readonly TestLog _log;

    public PriceCalculatorTests(ITestOutputHelper output)
    {
        _log = new TestLog(output);
    }

    [Fact]
    public void Subtotal_SumsLines()
    {
        var order = new Order(new Customer("c-1", "DE")).AddLine("BOOK", 10m, 2).AddLine("PEN", 1.5m);

        var subtotal = _calculator.Subtotal(order);

        _log.Write($"subtotal={subtotal}");
        Assert.Equal(21.5m, subtotal);
    }

    [Fact]
    public void Total_IncludesTax()
    {
        var order = new Order(new Customer("c-1", "DE")).AddLine("BOOK", 100m);

        var total = _calculator.Total(order);

        _log.Write($"total={total}");
        Assert.Equal(119m, total);
    }
}
