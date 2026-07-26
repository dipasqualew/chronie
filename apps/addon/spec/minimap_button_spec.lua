local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newMinimapButton", function()
    local ns = loader.load()

    it("builds on the minimap and opens segments when clicked", function()
        local createFrame, frames = fake.newCreateFrame()
        local opened = 0
        local tooltip = fake.newTooltip()
        local minimap = { frameName = "Minimap" }
        local button = ns.newMinimapButton({
            createFrame = createFrame,
            minimap = minimap,
            tooltip = tooltip,
            onClick = function()
                opened = opened + 1
            end,
        })

        button.show()
        frames[1]:run("OnClick")

        assert.equal("ChronieMinimapButton", frames[1].frameName)
        assert.equal(minimap, frames[1].parent)
        assert.equal(1, opened)
    end)

    it("shows a useful tooltip", function()
        local createFrame, frames = fake.newCreateFrame()
        local tooltip, recorded = fake.newTooltip()
        local button = ns.newMinimapButton({
            createFrame = createFrame,
            minimap = {},
            tooltip = tooltip,
            onClick = function() end,
        })

        button.show()
        frames[1]:run("OnEnter")

        assert.equal("chronie segments", recorded.lines[1].text)
        assert.equal("Drag to move", recorded.lines[3].text)
        assert.equal(1, recorded.shown)
        frames[1]:run("OnLeave")
        assert.equal(1, recorded.hidden)
    end)

    it("restores and saves its dragged position", function()
        local createFrame, frames = fake.newCreateFrame()
        local saved
        local minimap = fake.newFrame()
        minimap.center = { 100, 100 }
        local button = ns.newMinimapButton({
            createFrame = createFrame,
            minimap = minimap,
            tooltip = fake.newTooltip(),
            onClick = function() end,
            loadPoint = function()
                return "BOTTOMRIGHT", 8, 12
            end,
            savePoint = function(point, x, y)
                saved = { point, x, y }
            end,
        })

        button.show()
        assert.same({ "BOTTOMRIGHT", frames[1].parent, "BOTTOMRIGHT", 8, 12 }, frames[1].points[1])

        frames[1].center = { 120, 85 }
        frames[1]:run("OnDragStop")

        assert.same({ "CENTER", 20, -15 }, saved)
        assert.same({ "CENTER", minimap, "CENTER", 20, -15 }, frames[1].points[2])
    end)
end)
