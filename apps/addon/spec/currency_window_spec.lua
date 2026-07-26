local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newCurrencyWindow", function()
    local ns = loader.load()

    local NAME = "ChronieTestCurrencyWindow"

    ---Build the window over a real CurrencyItems store and fake frames, with a drivable
    ---cursor so a drop can be simulated.
    ---@param options table? `{ tracked = { [id] = name }, itemName = fun, point = { p, x, y } }`
    ---@return table window, table frames, table store, table recorded
    local function newWindow(options)
        options = options or {}
        local createFrame, frames = fake.newCreateFrame()
        local db = { currencyItems = {} }
        for id, name in pairs(options.tracked or {}) do
            db.currencyItems[id] = name
        end
        local store = ns.newCurrencyItems({ db = db })
        local recorded = { cursor = nil, cleared = 0, saved = {} }
        local window = ns.newCurrencyWindow({
            createFrame = createFrame,
            uiParent = { name = "UIParent" },
            name = options.name or NAME,
            specialFrames = {},
            items = store,
            getCursorItem = function()
                if not recorded.cursor then
                    return nil
                end
                return recorded.cursor.id, recorded.cursor.name
            end,
            clearCursor = function()
                recorded.cleared = recorded.cleared + 1
                recorded.cursor = nil
            end,
            itemName = options.itemName or function()
                return nil
            end,
            loadPoint = function()
                local point = options.point
                if not point then
                    return nil
                end
                return point[1], point[2], point[3]
            end,
            savePoint = function(point, x, y)
                recorded.saved[#recorded.saved + 1] = { point = point, x = x, y = y }
            end,
        })
        return window, frames, store, recorded
    end

    ---The main frame is the first one created.
    local function mainFrame(frames)
        return frames[1]
    end

    ---The drop slot is the Button built on the tooltip backdrop, as opposed to the close
    ---button on the UIPanelCloseButton template.
    local function slotOf(frames)
        for _, frame in ipairs(frames) do
            if frame.frameType == "Button" and frame.template == "BackdropTemplate" then
                return frame
            end
        end
        return nil
    end

    ---Reconstruct the visible rows: each is a left-justified name paired with the
    ---right-justified remove control created right after it.
    ---@param frame table
    ---@return table[] `{ { name = string, remove = table? }, ... }`
    local function rowsOf(frame)
        local names, removes = {}, {}
        for _, fontString in ipairs(frame.fontStrings) do
            if fontString.shown and fontString.justify == "LEFT" then
                names[#names + 1] = fontString
            elseif fontString.shown and fontString.justify == "RIGHT" then
                removes[#removes + 1] = fontString
            end
        end
        local rows = {}
        for index, name in ipairs(names) do
            rows[index] = { name = name.text, remove = removes[index] }
        end
        return rows
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newCurrencyWindow)
    end)

    describe("showing", function()
        it("builds hidden and shows on demand", function()
            local window, frames = newWindow()
            assert.is_false(window.isShown())

            window.show()

            assert.is_true(window.isShown())
            assert.is_true(mainFrame(frames):IsShown())
        end)

        it("toggles open and closed", function()
            local window = newWindow()

            window.toggle()
            assert.is_true(window.isShown())

            window.toggle()
            assert.is_false(window.isShown())
        end)

        it("restores a saved position", function()
            local window, frames = newWindow({ point = { "TOPLEFT", 40, -60 } })

            window.show()

            assert.same({ "TOPLEFT", { name = "UIParent" }, "TOPLEFT", 40, -60 }, mainFrame(frames).points[1])
        end)

        it("saves the position after a drag", function()
            local window, frames, _, recorded = newWindow()
            window.show()
            local frame = mainFrame(frames)
            frame.placedPoint = { "LEFT", nil, "LEFT", 15, 25 }

            frame:run("OnDragStop")

            assert.same({ point = "LEFT", x = 15, y = 25 }, recorded.saved[1])
        end)
    end)

    describe("the tracked list", function()
        it("shows an empty hint when nothing is tracked", function()
            local window, frames = newWindow()

            window.show()

            local rows = rowsOf(mainFrame(frames))
            assert.equal(1, #rows)
            assert.equal("Nothing tracked yet.", rows[1].name)
            assert.is_nil(rows[1].remove)
        end)

        it("lists tracked items with a remove control, sorted by name", function()
            local window, frames = newWindow({ tracked = { [2] = "Valor", [1] = "Honor" } })

            window.show()

            local rows = rowsOf(mainFrame(frames))
            assert.equal(2, #rows)
            assert.equal("Honor", rows[1].name)
            assert.equal("Valor", rows[2].name)
            assert.equal("remove", rows[1].remove.text)
        end)

        it("prefers a fresh localised name over the stored one", function()
            local window, frames = newWindow({
                tracked = { [5001] = "Stale Name" },
                itemName = function(id)
                    return "Fresh " .. id
                end,
            })

            window.show()

            assert.equal("Fresh 5001", rowsOf(mainFrame(frames))[1].name)
        end)
    end)

    describe("adding by drop", function()
        it("tracks the item on the cursor when dropped on the slot", function()
            local window, frames, store, recorded = newWindow()
            window.show()
            recorded.cursor = { id = 5001, name = "Bloody Token" }

            slotOf(frames):run("OnReceiveDrag")

            assert.is_true(store.has(5001))
            assert.equal("Bloody Token", store.list()[1].name)
        end)

        it("also tracks on a plain click with an item on the cursor", function()
            local window, frames, store, recorded = newWindow()
            window.show()
            recorded.cursor = { id = 5001, name = "Bloody Token" }

            slotOf(frames):run("OnClick")

            assert.is_true(store.has(5001))
        end)

        it("clears the cursor after tracking", function()
            local window, frames, _, recorded = newWindow()
            window.show()
            recorded.cursor = { id = 5001, name = "Bloody Token" }

            slotOf(frames):run("OnReceiveDrag")

            assert.equal(1, recorded.cleared)
            assert.is_nil(recorded.cursor)
        end)

        it("does nothing when the cursor is empty", function()
            local window, frames, store, recorded = newWindow()
            window.show()

            slotOf(frames):run("OnReceiveDrag")

            assert.same({}, store.ids())
            assert.equal(0, recorded.cleared)
        end)

        it("repaints so the new item appears immediately", function()
            local window, frames, _, recorded = newWindow()
            window.show()
            recorded.cursor = { id = 5001, name = "Bloody Token" }

            slotOf(frames):run("OnReceiveDrag")

            local rows = rowsOf(mainFrame(frames))
            assert.equal(1, #rows)
            assert.equal("Bloody Token", rows[1].name)
        end)
    end)

    describe("removing", function()
        it("drops the item when its remove control is clicked", function()
            local window, frames, store = newWindow({ tracked = { [5001] = "Bloody Token" } })
            window.show()

            rowsOf(mainFrame(frames))[1].remove:run("OnMouseUp", "LeftButton")

            assert.is_false(store.has(5001))
        end)

        it("repaints back to the empty hint after the last item goes", function()
            local window, frames = newWindow({ tracked = { [5001] = "Bloody Token" } })
            window.show()

            rowsOf(mainFrame(frames))[1].remove:run("OnMouseUp", "LeftButton")

            local rows = rowsOf(mainFrame(frames))
            assert.equal(1, #rows)
            assert.equal("Nothing tracked yet.", rows[1].name)
        end)

        it("removes only the clicked item", function()
            local window, frames, store = newWindow({ tracked = { [1] = "Honor", [2] = "Valor" } })
            window.show()

            -- Honor sorts first, so its remove control is the first row's.
            rowsOf(mainFrame(frames))[1].remove:run("OnMouseUp", "LeftButton")

            assert.same({ 2 }, store.ids())
        end)
    end)
end)
