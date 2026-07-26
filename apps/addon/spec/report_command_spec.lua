local loader = require("addon_loader")

describe("ns.newReportCommand", function()
    local ns = loader.load()

    ---@param lines ReportLine[]
    ---@return string
    local function joined(lines)
        local texts = {}
        for index, line in ipairs(lines) do
            texts[index] = line.text
        end
        return table.concat(texts, "\n")
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newReportCommand)
    end)

    describe("the default install", function()
        it("offers a watch command, a build command, and the report itself", function()
            local lines = ns.newReportCommand().lines()

            assert.equal(3, #lines)
            assert.is_truthy(lines[1].text:find(" --watch", 1, true))
            assert.is_truthy(lines[2].text:find(" --open", 1, true))
            assert.is_truthy(lines[3].text:find("report.html", 1, true))
        end)

        it("labels every line, since a bare command says nothing about when to run it", function()
            for _, line in ipairs(ns.newReportCommand().lines()) do
                assert.is_string(line.label)
                assert.is_true(#line.label > 0)
            end
        end)

        it("points at the collector inside the retail AddOns folder", function()
            local text = ns.newReportCommand().lines()[1].text

            assert.equal(
                'python "C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Interface\\AddOns\\chronie' ..
                '\\scripts\\collect.py" --watch',
                text
            )
        end)

        -- The default path has spaces in it, so an unquoted command would be parsed
        -- as three arguments and fail the moment it is pasted.
        it("quotes the script path", function()
            local text = ns.newReportCommand().lines()[2].text

            assert.is_truthy(text:find('"C:\\Program Files', 1, true))
            assert.is_truthy(text:find('collect.py"', 1, true))
        end)

        it("sends the player to the report under LOCALAPPDATA", function()
            assert.equal("%LOCALAPPDATA%\\wdp-wow\\report.html", ns.newReportCommand().lines()[3].text)
        end)

        it("treats an empty deps table as no deps at all", function()
            assert.same(ns.newReportCommand().lines(), ns.newReportCommand({}).lines())
        end)
    end)

    describe("a non-default install", function()
        it("uses the interpreter it was given", function()
            local lines = ns.newReportCommand({ python = "py -3" }).lines()

            assert.is_truthy(lines[1].text:find("^py %-3 "))
        end)

        it("uses the addon path it was given", function()
            local lines = ns.newReportCommand({ addonPath = "D:\\wow\\Interface\\AddOns\\chronie" }).lines()

            assert.is_truthy(joined(lines):find("D:\\wow\\Interface\\AddOns\\chronie\\scripts\\collect.py", 1, true))
        end)

        it("uses the output path it was given", function()
            local lines = ns.newReportCommand({ outputPath = "E:\\reports" }).lines()

            assert.equal("E:\\reports\\report.html", lines[3].text)
        end)
    end)
end)
