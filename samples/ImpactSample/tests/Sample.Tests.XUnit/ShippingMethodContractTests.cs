using Sample.Core.Orders;
using Sample.Core.Shipping;
using Sample.Tests.XUnit.Support;

namespace Sample.Tests.XUnit;

// Contract tests declared once in an abstract base class; xUnit runs them for every concrete subclass.
public abstract class ShippingMethodContractTests
{
    protected ShippingMethodContractTests()
    {
        Order = SampleOrders.SingleItem();
    }

    protected Order Order { get; }

    protected abstract ShippingMethod CreateMethod();

    [Fact]
    public void Cost_IsNeverNegative()
    {
        Assert.True(CreateMethod().Cost(Order) >= 0m);
    }

    [Fact]
    public void Name_IsNotEmpty()
    {
        Assert.False(string.IsNullOrWhiteSpace(CreateMethod().Name));
    }
}

public sealed class StandardShippingContractTests : ShippingMethodContractTests
{
    protected override ShippingMethod CreateMethod() => new StandardShipping();
}

public sealed class ExpressShippingContractTests : ShippingMethodContractTests
{
    protected override ShippingMethod CreateMethod() => new ExpressShipping();
}
