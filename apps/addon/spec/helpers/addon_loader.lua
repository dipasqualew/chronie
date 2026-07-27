---Loads the addon the way the WoW client does: parse the .toc, then execute each
---listed file with the (addonName, namespace) varargs. Because the .toc is the
---source of truth, a file missing from it fails the tests rather than only failing in game.
local loader = {}

local ROOT = (debug.getinfo(1, "S").source:match("@(.*/)") or "./") .. "../../"
local TOC = ROOT .. "chronie.toc"

---@return string[] relative file paths, in load order
function loader.tocFiles()
    local files = {}
    local handle = assert(io.open(TOC, "r"), "cannot open " .. TOC)
    for line in handle:lines() do
        line = line:gsub("%s+$", "")
        if line ~= "" and not line:match("^##") and not line:match("^#") then
            files[#files + 1] = (line:gsub("\\", "/"))
        end
    end
    handle:close()
    return files
end

---Reads one file out of the addon folder, so a test can assert on something the client
---parses rather than executes — Bindings.xml being the only one of those today, and it is
---not in the .toc at all, because the client finds it by name.
---@param relative string A path inside the addon folder.
---@return string contents
function loader.read(relative)
    local path = ROOT .. relative
    local handle = assert(io.open(path, "r"), "cannot open " .. path)
    local contents = handle:read("*a")
    handle:close()
    return contents
end

---@param addonName string?
---@return table namespace populated by the addon files
function loader.load(addonName)
    local ns = {}
    for _, relative in ipairs(loader.tocFiles()) do
        if relative:match("%.lua$") then
            local path = ROOT .. relative
            local chunk = assert(loadfile(path), "cannot load " .. path)
            chunk(addonName or "chronie", ns)
        else
            -- Nothing but Lua is listed today. Anything else the .toc grows would go to a
            -- client parser there is no Lua stand-in for; reading it at least fails here
            -- when the .toc promises a file that is not on disk.
            loader.read(relative)
        end
    end
    return ns
end

return loader
