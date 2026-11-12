using Sample.Core.Loyalty;
using Sample.Core.Orders;

namespace Sample.Tests.MSTest;

[TestClass]
public class LoyaltyServiceTests
{
    private LoyaltyService _service = null!;
    private Customer _customer = null!;

    [TestInitialize]
    public void Initialize()
    {
        _service = new LoyaltyService();
        _customer = TestCustomers.Create("c-1");
    }

    [DataTestMethod]
    [DataRow(99, false)]
    [DataRow(100, true)]
    public void CanRedeem_RespectsThreshold(int points, bool expected)
    {
        _customer.LoyaltyPoints = points;

        Assert.AreEqual(expected, _service.CanRedeem(_customer));
    }

    [TestMethod]
    public void Reset_ClearsPoints()
    {
        _customer.LoyaltyPoints = 250;

        _service.Reset(_customer);

        Assert.AreEqual(0, _customer.LoyaltyPoints);
    }
}
