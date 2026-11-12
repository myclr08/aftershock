using Sample.Core.Shipping;

namespace Sample.Tests.NUnit;

public class ExpressCostCaseTests
{
    private static readonly object[] ExpressCases =
    {
        new object[] { 1, 14.99 },
        new object[] { 2, 15.99 },
    };

    // String source name on purpose: no symbol reference from the attribute to ExpressCases.
    [TestCaseSource("ExpressCases")]
    public void Cost_ByQuantity(int quantity, double expected)
    {
        Assert.That(new ExpressShipping().Cost(TestOrders.WithQuantity(quantity)), Is.EqualTo((decimal)expected));
    }
}
