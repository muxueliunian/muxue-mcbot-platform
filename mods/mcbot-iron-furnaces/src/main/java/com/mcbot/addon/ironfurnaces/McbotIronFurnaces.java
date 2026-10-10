package com.mcbot.addon.ironfurnaces;

import com.mcbot.servercontrol.api.McbotApi;
import net.neoforged.fml.common.Mod;

/**
 * MCBOT add-on for Iron Furnaces. Registers the iron furnace container adapter with MCBOT; it reports itself as
 * installed only when Iron Furnaces 4.3.2 is present, so the add-on is harmless on servers without it.
 */
@Mod("mcbot_iron_furnaces")
public final class McbotIronFurnaces {
    public McbotIronFurnaces() {
        McbotApi.registerContainer(IronFurnaceAdapter.INSTANCE);
    }
}
