using Sample.Core.Orders;

namespace Sample.Tests.MSTest;

internal static class TestCustomers
{
    public static Customer Create(string id)
    {
        return new Customer(id, "DE");
    }
}
