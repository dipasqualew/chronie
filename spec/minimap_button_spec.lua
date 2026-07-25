local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newMinimapButton", function()
    local ns = loader.load()

    it("builds on the minimap and opens sessions when clicked", function()
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

        assert.equal("WdpWowMinimapButton", frames[1].frameName)
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

        assert.equal("wdp sessions", recorded.lines[1].text)
        assert.equal(1, recorded.shown)
        frames[1]:run("OnLeave")
        assert.equal(1, recorded.hidden)
    end)
end)
