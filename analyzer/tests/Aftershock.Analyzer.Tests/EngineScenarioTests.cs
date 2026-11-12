using Aftershock.Analyzer.Tests.Infrastructure;
using static Aftershock.Analyzer.Tests.Infrastructure.Expect;

namespace Aftershock.Analyzer.Tests;

/// <summary>
/// M1 acceptance scenarios on samples/ImpactSample. Every scenario asserts the exact set of selected tests.
/// </summary>
[Collection(SampleWorkspaceCollection.Name)]
public sealed class EngineScenarioTests
{
    private readonly SampleWorkspaceFixture _fixture;

    public EngineScenarioTests(SampleWorkspaceFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task DirectCall_SelectsCallingTests()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Catalog/ProductCatalog.cs", "_prices.TryGetValue(sku, out var price)", "_prices.TryGetValue(sku.Trim(), out var price)")
            .AnalyzeAsync();

        Selected(result,
            XUnit + "CatalogTests.Default_ContainsBook",
            XUnit + "CatalogImportTests.Import_ParsesPrices",
            XUnitV3 + "CatalogV3Tests.PriceOf_Book");
        NoFallback(result);
        var symbol = Assert.Single(result.ChangedSymbols);
        Assert.Equal("Sample.Core.Catalog.ProductCatalog.PriceOf(string)", symbol.Symbol);
        Assert.Equal("method", symbol.Kind);
        Assert.Equal("modified", symbol.Reason);
        Assert.Equal(new[] { "ProductCatalog.PriceOf", "CatalogTests.Default_ContainsBook" }, Test(result, XUnit + "CatalogTests.Default_ContainsBook").Chain);
    }

    [Fact]
    public async Task MultiLevelChain_FollowsCallersUpToTests()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Pricing/TaxRates.cs", "\"NL\" => 0.21m,", "\"NL\" => 0.21m,\n            \"FR\" => 0.20m,")
            .AnalyzeAsync();

        Selected(result,
            XUnit + "TaxRatesTests.ForCountry_ReturnsRate",
            XUnit + "PriceCalculatorTests.Total_IncludesTax",
            XUnit + "OrderServiceTests.PlaceOrder_ReturnsTotalWithTax",
            XUnit + "OrderServiceTests.PlaceOrder_SavesOrder",
            XUnit + "OrderServiceTests.PlaceOrder_WithoutLines_Throws");
        NoFallback(result);

        var chained = Test(result, XUnit + "OrderServiceTests.PlaceOrder_SavesOrder");
        Assert.Equal(
            new[] { "TaxRates.ForCountry", "PriceCalculator.Tax", "PriceCalculator.Total", "OrderService.PlaceOrder", "OrderServiceTests.PlaceOrder_SavesOrder" },
            chained.Chain);
        Assert.Equal("referenceChain", chained.Reason);
        Assert.Equal("xunit", chained.Framework);
        Assert.False(chained.Parameterized);
        Assert.EndsWith("Sample.Tests.XUnit.csproj", chained.Project);
        Assert.EndsWith("OrderServiceTests.cs", chained.File);
        Assert.True(chained.Line > 0);

        var theory = Test(result, XUnit + "TaxRatesTests.ForCountry_ReturnsRate");
        Assert.True(theory.Parameterized);
        Assert.Equal("xunit", theory.Framework);
        Assert.Equal("Sample.Tests.XUnit.TaxRatesTests", theory.ClassName);
        Assert.Equal("ForCountry_ReturnsRate", theory.MethodName);
    }

    [Fact]
    public async Task CallThroughInterface_IsFound()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Orders/InMemoryOrderRepository.cs", "_orders[order.Id] = order;\n    }\n\n    public Order? Find", "_orders[order.Id] = order ?? throw new ArgumentNullException(nameof(order));\n    }\n\n    public Order? Find")
            .AnalyzeAsync();

        Selected(result,
            XUnit + "OrderServiceTests.PlaceOrder_ReturnsTotalWithTax",
            XUnit + "OrderServiceTests.PlaceOrder_SavesOrder",
            XUnit + "OrderServiceTests.PlaceOrder_WithoutLines_Throws");
        Assert.Equal(
            new[] { "InMemoryOrderRepository.Save", "IOrderRepository.Save", "OrderService.PlaceOrder", "OrderServiceTests.PlaceOrder_SavesOrder" },
            Test(result, XUnit + "OrderServiceTests.PlaceOrder_SavesOrder").Chain);
    }

    [Fact]
    public async Task AbstractOverride_ReachesCallsThroughBaseClass_AndNUnitTestCases()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Shipping/ExpressShipping.cs", "14.99m + (items - 1)", "14.99m + ((items - 1) * 1.00m)")
            .AnalyzeAsync();

        Selected(result,
            XUnit + "StandardShippingContractTests.Cost_IsNeverNegative",
            XUnit + "ExpressShippingContractTests.Cost_IsNeverNegative",
            NUnit + "ShippingQuoteServiceTests.Quote_Standard",
            NUnit + "ShippingQuoteServiceTests.Quote_Express",
            NUnit + "ShippingQuoteServiceTests.Quote_Express_ByQuantity",
            NUnit + "ExpressCostCaseTests.Cost_ByQuantity");

        var testCase = Test(result, NUnit + "ShippingQuoteServiceTests.Quote_Express_ByQuantity");
        Assert.Equal("nunit", testCase.Framework);
        Assert.True(testCase.Parameterized);
        Assert.Equal(new[] { "ExpressShipping.Cost", "ShippingMethod.Cost", "ShippingQuoteService.Quote", "ShippingQuoteServiceTests.Quote_Express_ByQuantity" }, testCase.Chain);
        Assert.False(Test(result, NUnit + "ShippingQuoteServiceTests.Quote_Standard").Parameterized);
        Assert.True(Test(result, NUnit + "ExpressCostCaseTests.Cost_ByQuantity").Parameterized);
    }

    [Fact]
    public async Task VirtualOverride_ReachesCallsThroughBaseClass()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Shipping/ExpressShipping.cs", "return 1;", "return order.Lines.Count > 10 ? 2 : 1;")
            .AnalyzeAsync();

        Selected(result, NUnit + "ShippingQuoteServiceTests.Eta_Express_IsOneDay");
    }

    [Fact]
    public async Task PropertyGetter_SelectsOnlyReaders()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Orders/Customer.cs", "return _loyaltyPoints;", "return Math.Max(0, _loyaltyPoints);")
            .AnalyzeAsync();

        Selected(result,
            MSTest + "LoyaltyServiceTests.CanRedeem_RespectsThreshold",
            MSTest + "LoyaltyServiceTests.Reset_ClearsPoints",
            NUnit + "CustomerFormatterTests.Describe_IncludesPoints");
        Assert.Equal("getter", Assert.Single(result.ChangedSymbols).Kind);

        var dataTest = Test(result, MSTest + "LoyaltyServiceTests.CanRedeem_RespectsThreshold");
        Assert.Equal("mstest", dataTest.Framework);
        Assert.True(dataTest.Parameterized);
        Assert.False(Test(result, MSTest + "LoyaltyServiceTests.Reset_ClearsPoints").Parameterized);
    }

    [Fact]
    public async Task PropertySetter_SelectsOnlyWriters()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Orders/Customer.cs", "_loyaltyPoints = Math.Max(0, value);", "_loyaltyPoints = Math.Clamp(value, 0, 1_000_000);")
            .AnalyzeAsync();

        Selected(result,
            MSTest + "LoyaltyServiceTests.CanRedeem_RespectsThreshold",
            MSTest + "LoyaltyServiceTests.Reset_ClearsPoints");
        Assert.Equal("setter", Assert.Single(result.ChangedSymbols).Kind);
    }

    [Fact]
    public async Task XUnitTestClassConstructor_SelectsWholeClass()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Orders/OrderService.cs", "_repository = repository ?? throw new ArgumentNullException(nameof(repository));", "ArgumentNullException.ThrowIfNull(repository);\n        _repository = repository;")
            .AnalyzeAsync();

        Selected(result,
            XUnit + "OrderServiceTests.PlaceOrder_ReturnsTotalWithTax",
            XUnit + "OrderServiceTests.PlaceOrder_SavesOrder",
            XUnit + "OrderServiceTests.PlaceOrder_WithoutLines_Throws",
            XUnit + "OrderServiceTests.GetOrder_UnknownId_ReturnsNull");
        var test = Test(result, XUnit + "OrderServiceTests.GetOrder_UnknownId_ReturnsNull");
        Assert.Equal("classLifecycle", test.Reason);
        Assert.Equal(new[] { "OrderService..ctor", "OrderServiceTests..ctor", "OrderServiceTests.GetOrder_UnknownId_ReturnsNull" }, test.Chain);
    }

    [Fact]
    public async Task HelperBuiltFromTestOutputHelperInConstructor_SelectsWholeClass()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.XUnit/Support/TestLog.cs", "_output = output;", "_output = output ?? throw new ArgumentNullException(nameof(output));")
            .AnalyzeAsync();

        Selected(result,
            XUnit + "PriceCalculatorTests.Subtotal_SumsLines",
            XUnit + "PriceCalculatorTests.Total_IncludesTax");
    }

    [Fact]
    public async Task BaseClassConstructorOfTestClass_SelectsAllDerivedTestClasses()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.XUnit/Support/SampleOrders.cs", "AddLine(\"MUG\", 8.00m)", "AddLine(\"MUG\", 9.00m)")
            .AnalyzeAsync();

        Selected(result,
            XUnit + "StandardShippingContractTests.Cost_IsNeverNegative",
            XUnit + "StandardShippingContractTests.Name_IsNotEmpty",
            XUnit + "ExpressShippingContractTests.Cost_IsNeverNegative",
            XUnit + "ExpressShippingContractTests.Name_IsNotEmpty");
        var test = Test(result, XUnit + "ExpressShippingContractTests.Name_IsNotEmpty");
        Assert.Equal("Sample.Tests.XUnit.ShippingMethodContractTests", test.DeclaredIn);
        Assert.Equal("classLifecycle", test.Reason);
    }

    [Fact]
    public async Task NUnitSetUp_SelectsWholeFixture()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.NUnit/TestOrders.cs", "AddLine(\"BOOK\", 12.50m)", "AddLine(\"BOOK\", 12.50m, 1)")
            .AnalyzeAsync();

        Selected(result,
            NUnit + "ShippingQuoteServiceTests.Quote_Standard",
            NUnit + "ShippingQuoteServiceTests.Quote_Express",
            NUnit + "ShippingQuoteServiceTests.Quote_Express_ByQuantity",
            NUnit + "ShippingQuoteServiceTests.Eta_Express_IsOneDay");
        Assert.All(result.Tests, t => Assert.Equal("classLifecycle", t.Reason));
    }

    [Fact]
    public async Task MSTestTestInitialize_SelectsWholeClass()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.MSTest/TestCustomers.cs", "new Customer(id, \"DE\")", "new Customer(id, \"NL\")")
            .AnalyzeAsync();

        Selected(result,
            MSTest + "LoyaltyServiceTests.CanRedeem_RespectsThreshold",
            MSTest + "LoyaltyServiceTests.Reset_ClearsPoints");
    }

    [Fact]
    public async Task ClassFixtureAndV3CollectionFixture_SelectWholeClasses()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Catalog/ProductCatalog.cs", "catalog.Add(\"MUG\", 8.00m);", "catalog.Add(\"MUG\", 8.50m);")
            .AnalyzeAsync();

        Selected(result,
            XUnit + "CatalogTests.Default_ContainsBook",
            XUnit + "CatalogTests.Default_HasThreeProducts",
            XUnitV3 + "CatalogV3Tests.PriceOf_Book",
            XUnitV3 + "CatalogCountV3Tests.Count_IsThree");
        Assert.Equal("fixture", Test(result, XUnit + "CatalogTests.Default_HasThreeProducts").Reason);
        Assert.Equal(
            new[] { "ProductCatalog.CreateDefault", "CatalogV3Fixture.InitializeAsync", "CatalogV3Tests.PriceOf_Book" },
            Test(result, XUnitV3 + "CatalogV3Tests.PriceOf_Book").Chain);
    }

    [Fact]
    public async Task NamedCollectionFixture_SelectsEveryClassInTheCollection()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.XUnit/Support/SampleOrders.cs", "AddLine(\"PEN\", 1.20m, 3)", "AddLine(\"PEN\", 1.20m, 4)")
            .AnalyzeAsync();

        Selected(result,
            XUnit + "RepositoryLookupTests.Find_ReturnsSeededOrder",
            XUnit + "RepositoryLookupTests.Find_Unknown_ReturnsNull",
            XUnit + "RepositoryCountTests.Count_MatchesSeed");
    }

    [Fact]
    public async Task AsyncLifetimeInitialize_SelectsWholeClass()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Catalog/CatalogImporter.cs", "var parts = line.Split(';');", "var parts = line.Split(';', StringSplitOptions.TrimEntries);")
            .AnalyzeAsync();

        Selected(result,
            XUnit + "CatalogImportTests.Import_ReadsAllRows",
            XUnit + "CatalogImportTests.Import_ParsesPrices");
    }

    [Fact]
    public async Task MemberDataWithNameof_SelectsTheory()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.XUnit/DiscountTests.cs", "yield return new object[] { 80m, 25m, 60m };", "yield return new object[] { 80m, 25m, 60m };\n        yield return new object[] { 10m, 50m, 5m };")
            .AnalyzeAsync();

        Selected(result, XUnit + "DiscountTests.Apply_Percent");
        Assert.True(Test(result, XUnit + "DiscountTests.Apply_Percent").Parameterized);
    }

    [Fact]
    public async Task MemberDataWithStringName_SelectsTheory()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.XUnit/DiscountTests.cs", "{ 3m, 5m, 0m },", "{ 3m, 5m, 0m },\n        { 5m, 5m, 0m },")
            .AnalyzeAsync();

        var test = Test(result, XUnit + "DiscountTests.Apply_Flat");
        Selected(result, XUnit + "DiscountTests.Apply_Flat");
        Assert.Equal("dataSource", test.Reason);
        Assert.Equal(new[] { "DiscountTests.FlatCases.get", "DiscountTests.Apply_Flat" }, test.Chain);
    }

    [Fact]
    public async Task MemberDataWithMemberType_SelectsTheory()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.XUnit/DiscountTests.cs", "new object[] { 200m, 50m, 100m },", "new object[] { 200m, 50m, 100m },\n            new object[] { 100m, 20m, 80m },")
            .AnalyzeAsync();

        Selected(result, XUnit + "DiscountTests.Apply_Seasonal");
    }

    [Fact]
    public async Task ClassData_SelectsTheory()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.XUnit/DiscountTests.cs", "yield return new object[] { 100m, \"UNKNOWN\", 100m };", "yield return new object[] { 100m, \"UNKNOWN\", 100m };\n        yield return new object[] { 3m, \"FIVEOFF\", 0m };")
            .AnalyzeAsync();

        Selected(result, XUnit + "DiscountTests.Apply_Coupon");
    }

    [Fact]
    public async Task XUnitV3MemberData_SelectsTheory()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.XUnitV3/MoneyV3Tests.cs", "{ 0.5m, 0.25m, 0.75m },", "{ 0.5m, 0.25m, 0.75m },\n        { 2m, 2m, 4m },")
            .AnalyzeAsync();

        Selected(result, XUnitV3 + "MoneyV3Tests.Add_ReturnsSum");
        var test = Test(result, XUnitV3 + "MoneyV3Tests.Add_ReturnsSum");
        Assert.Equal("xunit", test.Framework);
        Assert.True(test.Parameterized);
    }

    [Fact]
    public async Task XUnitV3GenericClassData_SelectsTheory()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.XUnitV3/MoneyV3Tests.cs", "Add(5m, 2m);", "Add(5m, 3m);")
            .AnalyzeAsync();

        Selected(result, XUnitV3 + "MoneyV3Tests.Add_IsCommutative");
        Assert.Equal("dataSource", Test(result, XUnitV3 + "MoneyV3Tests.Add_IsCommutative").Reason);
    }

    [Fact]
    public async Task XUnitV3AssemblyFixture_RunsTheWholeTestProject()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.XUnitV3/AssemblySetup.cs", "return \"sample-\" + Environment.ProcessorCount;", "return \"sample/\" + Environment.ProcessorCount;")
            .AnalyzeAsync();

        Selected(result);
        Fallback(result, Aftershock.Analyzer.Engine.FallbackKinds.AssemblySetup, "Sample.Tests.XUnitV3");
        Assert.Contains("TestEnvironmentFixture..ctor", Assert.Single(result.Fallback!.Reasons).Message);
    }

    [Fact]
    public async Task NUnitTestCaseSourceWithStringName_SelectsTest()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.NUnit/ExpressCostCaseTests.cs", "new object[] { 2, 15.99 },", "new object[] { 2, 15.99 },\n        new object[] { 3, 16.99 },")
            .AnalyzeAsync();

        Selected(result, NUnit + "ExpressCostCaseTests.Cost_ByQuantity");
    }

    [Fact]
    public async Task Operator_SelectsTestsUsingIt()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Pricing/Money.cs", "throw new InvalidOperationException(\"Currencies must match.\");", "throw new InvalidOperationException($\"Currencies must match: {left.Currency} vs {right.Currency}.\");")
            .AnalyzeAsync();

        Selected(result,
            XUnit + "MoneyTests.Add_SameCurrency_SumsAmounts",
            XUnitV3 + "MoneyV3Tests.Add_ReturnsSum",
            XUnitV3 + "MoneyV3Tests.Add_IsCommutative");
        Assert.Equal("operator", Assert.Single(result.ChangedSymbols).Kind);
    }

    [Fact]
    public async Task ChangeReachingNoTest_SelectsNothing()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Reporting/SalesReport.cs", "orders, {list.Sum", "order(s), {list.Sum")
            .AnalyzeAsync();

        Selected(result);
        NoFallback(result);
        Assert.Single(result.ChangedSymbols);
        Assert.Empty(result.TestProjects);
    }

    [Fact]
    public async Task CommentOnlyChange_IsNotAChange()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Pricing/PriceCalculator.cs", "// Tax is rounded to two decimals per order, not per line.", "// Tax is rounded once per order (two decimals).\n    // Rounding per line would drift.")
            .Replace("src/Sample.Core/Pricing/TaxRates.cs", "    public static decimal ForCountry(string countryCode)\n    {", "    public static decimal ForCountry(string countryCode)\n    {\n        // Rates are percentages divided by 100.\n")
            .AnalyzeAsync();

        Selected(result);
        Assert.Empty(result.ChangedSymbols);
        NoFallback(result);
    }

    [Fact]
    public async Task NewTestMethod_SelectsOnlyTheNewTest()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.XUnit/PriceCalculatorTests.cs", "    [Fact]\n    public void Total_IncludesTax()", "    [Fact]\n    public void Subtotal_EmptyOrder_IsZero()\n    {\n        Assert.Equal(0m, _calculator.Subtotal(new Order(new Customer(\"c-2\", \"DE\"))));\n    }\n\n    [Fact]\n    public void Total_IncludesTax()")
            .AnalyzeAsync();

        Selected(result, XUnit + "PriceCalculatorTests.Subtotal_EmptyOrder_IsZero");
        Assert.Equal("changedTest", Test(result, XUnit + "PriceCalculatorTests.Subtotal_EmptyOrder_IsZero").Reason);
        var symbol = Assert.Single(result.ChangedSymbols);
        Assert.Equal("added", symbol.Reason);
        Assert.Contains("Subtotal_EmptyOrder_IsZero", symbol.Symbol);
    }

    [Fact]
    public async Task NewHelperInTestClass_IsFollowedThroughItsReferences()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.XUnit/OrderServiceTests.cs", "        var order = new Order(new Customer(\"c-1\", \"DE\")).AddLine(\"PEN\", 2m);\n", "        var order = PenOrder();\n")
            .Replace("tests/Sample.Tests.XUnit/OrderServiceTests.cs", "    [Fact]\n    public void PlaceOrder_WithoutLines_Throws()", "    private static Order PenOrder() => new Order(new Customer(\"c-1\", \"DE\")).AddLine(\"PEN\", 2m);\n\n    [Fact]\n    public void PlaceOrder_WithoutLines_Throws()")
            .AnalyzeAsync();

        Selected(result, XUnit + "OrderServiceTests.PlaceOrder_SavesOrder");
        Assert.DoesNotContain(result.ChangedSymbols, s => s.Kind == "type");
    }

    [Fact]
    public async Task NewMemberInProductionType_ChangesEveryMemberOfTheType()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Pricing/PriceCalculator.cs", "    public decimal Total(Order order)", "    public decimal Discount(Order order)\n    {\n        return 0m;\n    }\n\n    public decimal Total(Order order)")
            .AnalyzeAsync();

        // Spec rule for production types: a new member (it may capture overload resolution) changes the type.
        Selected(result,
            XUnit + "PriceCalculatorTests.Subtotal_SumsLines",
            XUnit + "PriceCalculatorTests.Total_IncludesTax",
            XUnit + "OrderServiceTests.PlaceOrder_ReturnsTotalWithTax",
            XUnit + "OrderServiceTests.PlaceOrder_SavesOrder",
            XUnit + "OrderServiceTests.PlaceOrder_WithoutLines_Throws",
            XUnit + "OrderServiceTests.GetOrder_UnknownId_ReturnsNull");
        Assert.Contains(result.ChangedSymbols, s => s.Reason == "added" && s.Symbol.Contains("Discount", StringComparison.Ordinal));
        Assert.Contains(result.ChangedSymbols, s => s.Reason == "typeChanged" && s.Symbol == "Sample.Core.Pricing.PriceCalculator");
    }

    [Fact]
    public async Task NewMemberPlusFieldChangeInTestClass_SelectsWholeClass()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.XUnit/PriceCalculatorTests.cs", "    private readonly PriceCalculator _calculator = new();", "    private readonly PriceCalculator _calculator = new PriceCalculator();")
            .Replace("tests/Sample.Tests.XUnit/PriceCalculatorTests.cs", "    [Fact]\n    public void Total_IncludesTax()", "    private static int Unused() => 0;\n\n    [Fact]\n    public void Total_IncludesTax()")
            .AnalyzeAsync();

        // The field initializer change is a type-level change on its own, so the class runs.
        Selected(result,
            XUnit + "PriceCalculatorTests.Subtotal_SumsLines",
            XUnit + "PriceCalculatorTests.Total_IncludesTax");
    }

    [Fact]
    public async Task ChangedInheritedTestMethod_RunsUnderEveryConcreteSubclass()
    {
        var result = await _fixture.Change()
            .Replace("tests/Sample.Tests.XUnit/ShippingMethodContractTests.cs", "Assert.False(string.IsNullOrWhiteSpace(CreateMethod().Name));", "var name = CreateMethod().Name;\n        Assert.False(string.IsNullOrWhiteSpace(name));")
            .AnalyzeAsync();

        Selected(result,
            XUnit + "StandardShippingContractTests.Name_IsNotEmpty",
            XUnit + "ExpressShippingContractTests.Name_IsNotEmpty");
        var test = Test(result, XUnit + "StandardShippingContractTests.Name_IsNotEmpty");
        Assert.Equal("changedTest", test.Reason);
        Assert.Equal("Sample.Tests.XUnit.ShippingMethodContractTests", test.DeclaredIn);
        Assert.Equal(new[] { "StandardShippingContractTests.Name_IsNotEmpty" }, test.Chain);
    }

    [Fact]
    public async Task DeletedOverride_IsResolvedInTheOldSnapshot()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Shipping/ExpressShipping.cs", "\n    public override int EstimatedDays(Order order)\n    {\n        return 1;\n    }\n", string.Empty)
            .AnalyzeAsync();

        Selected(result, NUnit + "ShippingQuoteServiceTests.Eta_Express_IsOneDay");
        var deleted = Assert.Single(result.ChangedSymbols);
        Assert.Equal("deleted", deleted.Reason);
        Assert.Equal(
            new[] { "ExpressShipping.EstimatedDays (removed)", "ShippingMethod.EstimatedDays", "ShippingQuoteService.Eta", "ShippingQuoteServiceTests.Eta_Express_IsOneDay" },
            Test(result, NUnit + "ShippingQuoteServiceTests.Eta_Express_IsOneDay").Chain);
    }

    [Fact]
    public async Task DeletedFiles_AreAnalyzedFromTheOldSnapshot()
    {
        var change = _fixture.Change()
            .Delete("src/Sample.Core/Customers/CustomerFormatter.cs")
            .Delete("tests/Sample.Tests.NUnit/CustomerFormatterTests.cs");
        var result = await change.AnalyzeAsync();

        Selected(result);
        NoFallback(result);
        Assert.Contains(result.ChangedSymbols, s => s.Reason == "deletedFile" && s.Symbol == "Sample.Core.Customers.CustomerFormatter");
        Assert.Contains(result.ChangedSymbols, s => s.Reason == "deletedFile" && s.Symbol == "Sample.Tests.NUnit.CustomerFormatterTests");
        Assert.All(result.ChangedFiles, f => Assert.Equal("selective", f.Analysis));
        Assert.DoesNotContain(change.Diagnostics, d => d.Severity == "error");
    }

    [Fact]
    public async Task DeletedFile_WithUpdatedCaller_SelectsTheCaller()
    {
        // Deleting the formatter and changing its caller test: the old snapshot shows the test used it.
        var result = await _fixture.Change()
            .Delete("src/Sample.Core/Customers/CustomerFormatter.cs")
            .Replace("tests/Sample.Tests.NUnit/CustomerFormatterTests.cs", "Assert.That(CustomerFormatter.Describe(customer), Is.EqualTo(\"c-9 (NL): 0 points\"));", "Assert.That(customer.Id, Is.EqualTo(\"c-9\"));")
            .Replace("tests/Sample.Tests.NUnit/CustomerFormatterTests.cs", "using Sample.Core.Customers;\n", string.Empty)
            .AnalyzeAsync();

        Selected(result, NUnit + "CustomerFormatterTests.Describe_IncludesPoints");
    }

    [Fact]
    public async Task NewFiles_AllMembersAreChanged()
    {
        var result = await _fixture.Change()
            .Add("src/Sample.Core/Pricing/BulkDiscount.cs", """
                using Sample.Core.Orders;

                namespace Sample.Core.Pricing;

                public static class BulkDiscount
                {
                    public static decimal Rate(Order order) => order.Lines.Sum(l => l.Quantity) >= 10 ? 0.05m : 0m;
                }
                """)
            .Add("tests/Sample.Tests.NUnit/BulkDiscountTests.cs", """
                using Sample.Core.Orders;
                using Sample.Core.Pricing;

                namespace Sample.Tests.NUnit;

                public class BulkDiscountTests
                {
                    [Test]
                    public void Rate_TenOrMoreItems_IsFivePercent()
                    {
                        var order = new Order(new Customer("c-1", "DE")).AddLine("PEN", 1m, 10);
                        Assert.That(BulkDiscount.Rate(order), Is.EqualTo(0.05m));
                    }
                }
                """)
            .AnalyzeAsync();

        Selected(result, NUnit + "BulkDiscountTests.Rate_TenOrMoreItems_IsFivePercent");
        Assert.Contains(result.ChangedSymbols, s => s.Reason == "newFile" && s.Symbol == "Sample.Core.Pricing.BulkDiscount");
        Assert.All(result.ChangedFiles, f => Assert.Equal("untracked", f.Status));
    }

    [Fact]
    public async Task FieldChange_ChangesTheWholeType()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Loyalty/LoyaltyService.cs", "RedeemThreshold = 100;", "RedeemThreshold = 150;")
            .AnalyzeAsync();

        Selected(result,
            MSTest + "LoyaltyServiceTests.CanRedeem_RespectsThreshold",
            MSTest + "LoyaltyServiceTests.Reset_ClearsPoints");
        var symbol = Assert.Single(result.ChangedSymbols);
        Assert.Equal("typeChanged", symbol.Reason);
        Assert.Equal("Sample.Core.Loyalty.LoyaltyService", symbol.Symbol);
    }

    [Fact]
    public async Task UsingChange_ChangesEveryTypeOfTheFile()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Pricing/TaxRates.cs", "namespace Sample.Core.Pricing;", "using System.Globalization;\n\nnamespace Sample.Core.Pricing;")
            .AnalyzeAsync();

        Selected(result,
            XUnit + "TaxRatesTests.ForCountry_ReturnsRate",
            XUnit + "PriceCalculatorTests.Total_IncludesTax",
            XUnit + "OrderServiceTests.PlaceOrder_ReturnsTotalWithTax",
            XUnit + "OrderServiceTests.PlaceOrder_SavesOrder",
            XUnit + "OrderServiceTests.PlaceOrder_WithoutLines_Throws");
        Assert.Equal("fileChanged", Assert.Single(result.ChangedSymbols).Reason);
    }

    [Fact]
    public async Task TypeAttributeChange_ChangesTheWholeType()
    {
        var result = await _fixture.Change()
            .Replace("src/Sample.Core/Shipping/ShippingQuoteService.cs", "public sealed class ShippingQuoteService", "[System.Diagnostics.DebuggerDisplay(\"quotes\")]\npublic sealed class ShippingQuoteService")
            .AnalyzeAsync();

        // Quote, Eta and the implicit constructor (used in the NUnit SetUp) are all considered changed.
        Selected(result,
            NUnit + "ShippingQuoteServiceTests.Quote_Standard",
            NUnit + "ShippingQuoteServiceTests.Quote_Express",
            NUnit + "ShippingQuoteServiceTests.Quote_Express_ByQuantity",
            NUnit + "ShippingQuoteServiceTests.Eta_Express_IsOneDay");
        Assert.Contains("attributes", Assert.Single(result.ChangedSymbols).Detail);
    }
}
