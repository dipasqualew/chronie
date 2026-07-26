local _, ns = ...

---One copyable line of the report window.
---@class ReportLine
---@field label string What the line is for.
---@field text string The thing to copy.

---Builds the shell commands that drive the out-of-game collector. The addon cannot
---run them itself — it has no filesystem or process access — so it can only hand the
---player something to paste. Pure string assembly, defaults aimed at the Windows
---client that scripts/install.ps1 installs into.
---@class ReportCommand
---@field lines fun(): ReportLine[]

---@class ReportCommandDeps
---@field python string? Interpreter name. Default "python".
---@field addonPath string? Where this addon is installed.
---@field outputPath string? Where the collector writes its report.

local DEFAULT_PYTHON = "python"
local DEFAULT_ADDON_PATH = "C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Interface\\AddOns\\chronie"
local DEFAULT_OUTPUT_PATH = "%LOCALAPPDATA%\\wdp-wow"

---@param deps ReportCommandDeps?
---@return ReportCommand
function ns.newReportCommand(deps)
    deps = deps or {}
    local python = deps.python or DEFAULT_PYTHON
    local addonPath = deps.addonPath or DEFAULT_ADDON_PATH
    local outputPath = deps.outputPath or DEFAULT_OUTPUT_PATH

    -- Quoted because the default install path has spaces in it.
    local script = string.format('%s "%s\\scripts\\collect.py"', python, addonPath)

    return {
        ---@return ReportLine[]
        lines = function()
            return {
                {
                    label = "1. Collect in the background (leave this running)",
                    text = script .. " --watch",
                },
                {
                    label = "2. Build the report and open it in your browser",
                    text = script .. " --open",
                },
                {
                    label = "3. Or re-open the last report (Win+R)",
                    text = outputPath .. "\\report.html",
                },
            }
        end,
    }
end
