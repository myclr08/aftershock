using Sample.Core.Customers;
using Sample.Core.Orders;

namespace Sample.Tests.NUnit;

public class CustomerFormatterTests
{
    [Test]
    public void Describe_IncludesPoints()
    {
        var customer = new Customer("c-9", "NL");

        Assert.That(CustomerFormatter.Describe(customer), Is.EqualTo("c-9 (NL): 0 points"));
    }
}
