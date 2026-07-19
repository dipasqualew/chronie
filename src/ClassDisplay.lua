local _, ns = ...

---Turns a class token into the colour and icon markup the UI draws it with.
---@class ClassDisplay
---@field colorOf fun(classFile: string?): number, number, number
---@field icon fun(classFile: string?): string
---@field decorate fun(classFile: string?, name: string): string
---@field label fun(classFile: string?, name: string): string

---@class ClassDisplayDeps
---@field classColor fun(classFile: string): (number?, number?, number?) Usually RAID_CLASS_COLORS.
---@field classIconCoords table<string, number[]> `{ left, right, top, bottom }` in 0-1 space.
---@field iconSize integer? Pixel size of the inline class icon. Default 14.

---The circular class portraits every client ships with. One 256x256 sheet, indexed
---by the 0-1 coordinates Blizzard publishes in CLASS_ICON_TCOORDS.
local CLASS_ICON_TEXTURE = "Interface\\TargetingFrame\\UI-Classes-Circles"
local SHEET_SIZE = 256
local DEFAULT_ICON_SIZE = 14

---Used when a character was recorded before we knew its class, so the row still
---lines up with its neighbours instead of jumping left.
local UNKNOWN_COLOR = { 0.8, 0.8, 0.8 }

---@param value number
---@return integer
local function toByte(value)
    local scaled = math.floor(value * 255 + 0.5)
    if scaled < 0 then
        return 0
    end
    if scaled > 255 then
        return 255
    end
    return scaled
end

---@param deps ClassDisplayDeps
---@return ClassDisplay
function ns.newClassDisplay(deps)
    local classColor = deps.classColor
    local classIconCoords = deps.classIconCoords or {}
    local iconSize = deps.iconSize or DEFAULT_ICON_SIZE

    ---@param classFile string?
    ---@return number, number, number
    local function colorOf(classFile)
        if classFile then
            local r, g, b = classColor(classFile)
            if r and g and b then
                return r, g, b
            end
        end
        return UNKNOWN_COLOR[1], UNKNOWN_COLOR[2], UNKNOWN_COLOR[3]
    end

    ---Inline texture markup cropped to one cell of the class sheet. Blizzard's
    ---coordinates are 0-1 but the escape sequence wants pixels, hence the scaling.
    ---@param classFile string?
    ---@return string
    local function icon(classFile)
        local coords = classFile and classIconCoords[classFile]
        if not coords then
            return ""
        end

        return string.format(
            "|T%s:%d:%d:0:0:%d:%d:%d:%d:%d:%d|t",
            CLASS_ICON_TEXTURE,
            iconSize,
            iconSize,
            SHEET_SIZE,
            SHEET_SIZE,
            coords[1] * SHEET_SIZE,
            coords[2] * SHEET_SIZE,
            coords[3] * SHEET_SIZE,
            coords[4] * SHEET_SIZE
        )
    end

    ---Icon plus plain name, for callers that colour the whole cell themselves.
    ---@param classFile string?
    ---@param name string
    ---@return string
    local function label(classFile, name)
        local art = icon(classFile)
        if art == "" then
            return name
        end
        return art .. " " .. name
    end

    return {
        colorOf = colorOf,
        icon = icon,
        label = label,

        ---Icon plus name coloured inline, for callers whose cell colour already
        ---means something else — a status, say — and must not be overwritten.
        ---@param classFile string?
        ---@param name string
        ---@return string
        decorate = function(classFile, name)
            if not classFile then
                return label(classFile, name)
            end

            local r, g, b = colorOf(classFile)
            local colored = string.format("|cff%02x%02x%02x%s|r", toByte(r), toByte(g), toByte(b), name)
            return label(classFile, colored)
        end,
    }
end
