using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Sample.Core.Orders;
using Sample.Web;

namespace Sample.Tests.XUnit;

public class ServiceRegistrationTests
{
    [Fact]
    public void AddShop_ResolvesOrderService()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Shop:Currency"] = "EUR" })
            .Build();

        using var provider = new ServiceCollection().AddShop(configuration).BuildServiceProvider();

        Assert.NotNull(provider.GetRequiredService<OrderService>());
    }
}
