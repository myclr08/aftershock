using Sample.Core.Orders;
using Sample.Core.Shipping;

namespace Sample.Tests.NUnit;

[TestFixture]
public class ShippingQuoteServiceTests
{
    private ShippingQuoteService _service = null!;
    private Order _order = null!;

    [SetUp]
    public void SetUp()
    {
        _service = new ShippingQuoteService();
        _order = TestOrders.SingleBook();
    }

    [Test]
    public void Quote_Standard()
    {
        Assert.That(_service.Quote(new StandardShipping(), _order), Is.EqualTo(4.99m));
    }

    [Test]
    public void Quote_Express()
    {
        Assert.That(_service.Quote(new ExpressShipping(), _order), Is.EqualTo(14.99m));
    }

    [TestCase(1, 14.99)]
    [TestCase(3, 16.99)]
    public void Quote_Express_ByQuantity(int quantity, double expected)
    {
        var order = new Order(_order.Customer).AddLine("PEN", 1.20m, quantity);

        Assert.That(_service.Quote(new ExpressShipping(), order), Is.EqualTo((decimal)expected));
    }

    [Test]
    public void Eta_Express_IsOneDay()
    {
        Assert.That(_service.Eta(new ExpressShipping(), _order), Is.EqualTo(1));
    }
}
