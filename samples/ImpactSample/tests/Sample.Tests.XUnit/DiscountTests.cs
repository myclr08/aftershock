using System.Collections;
using Sample.Core.Discounts;

namespace Sample.Tests.XUnit;

public class DiscountTests
{
    public static IEnumerable<object[]> PercentCases()
    {
        yield return new object[] { 100m, 10m, 90m };
        yield return new object[] { 80m, 25m, 60m };
    }

    public static TheoryData<decimal, decimal, decimal> FlatCases => new()
    {
        { 20m, 5m, 15m },
        { 3m, 5m, 0m },
    };

    [Theory]
    [MemberData(nameof(PercentCases))]
    public void Apply_Percent(decimal amount, decimal percent, decimal expected)
    {
        Assert.Equal(expected, DiscountCalculator.ApplyPercent(amount, percent));
    }

    // String member name on purpose: there is no symbol reference from the attribute to FlatCases.
#pragma warning disable xUnit1014 // the string form is part of the fixture
    [Theory]
    [MemberData("FlatCases")]
    public void Apply_Flat(decimal amount, decimal flat, decimal expected)
    {
        Assert.Equal(expected, DiscountCalculator.ApplyFlat(amount, flat));
    }
#pragma warning restore xUnit1014

    [Theory]
    [MemberData(nameof(SharedDiscountData.Seasonal), MemberType = typeof(SharedDiscountData))]
    public void Apply_Seasonal(decimal amount, decimal percent, decimal expected)
    {
        Assert.Equal(expected, DiscountCalculator.ApplyPercent(amount, percent));
    }

    [Theory]
    [ClassData(typeof(CouponCases))]
    public void Apply_Coupon(decimal amount, string code, decimal expected)
    {
        Assert.Equal(expected, DiscountCalculator.ApplyCoupon(amount, code));
    }
}

public static class SharedDiscountData
{
    public static IEnumerable<object[]> Seasonal =>
        new[]
        {
            new object[] { 200m, 50m, 100m },
        };
}

public sealed class CouponCases : IEnumerable<object[]>
{
    public IEnumerator<object[]> GetEnumerator()
    {
        yield return new object[] { 100m, "WELCOME10", 90m };
        yield return new object[] { 100m, "FIVEOFF", 95m };
        yield return new object[] { 100m, "UNKNOWN", 100m };
    }

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}
