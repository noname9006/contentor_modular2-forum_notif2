'use strict';

/**
 * Reads tracked_roles from settings (array of {id, name, position} sorted highest position first).
 * Given a discord.js GuildMember, returns the role object with highest position that the member has.
 * Returns null if no match.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {Array<{id: string, name: string, position: number}>} trackedRoles
 * @returns {{id: string, name: string, position: number}|null}
 */
function getHighestTrackedRole(member, trackedRoles) {
    if (!Array.isArray(trackedRoles) || trackedRoles.length === 0) return null;
    if (!member || !member.roles) return null;

    // trackedRoles is already sorted highest position first
    for (const role of trackedRoles) {
        if (member.roles.cache.has(role.id)) {
            return role;
        }
    }
    return null;
}

module.exports = { getHighestTrackedRole };
