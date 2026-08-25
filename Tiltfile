# A dumb adapter. Every resource shells out to `fo`; there is no logic here.
#
# The boundary rule (PLAN.md section 10): Tilt may only INVOKE `fo`, never the
# reverse, and everything here must be reachable with Tilt not running — which
# `fo watch` does. Keep this file under 100 lines and free of business logic,
# so that replacing Tilt is a weekend rather than a rewrite.

fo_env = os.getenv('FO_ENV', 'dev')
fo = 'fo --env ' + fo_env

# `fo up` has already converged the cluster by the time Tilt starts, so Tilt
# owns only the live phase.

local_resource(
    'idm-conf',
    cmd = fo + ' sync conf',
    deps = ['platform/idm/conf'],
    labels = ['fast'],
    trigger_mode = TRIGGER_MODE_AUTO,
)

local_resource(
    'idm-script',
    cmd = fo + ' sync script',
    deps = ['platform/idm/script'],
    labels = ['fast'],
    trigger_mode = TRIGGER_MODE_AUTO,
)

local_resource(
    'amster',
    cmd = fo + ' amster',
    deps = ['platform/amster/config'],
    labels = ['slow'],
    trigger_mode = TRIGGER_MODE_AUTO,
)

# PingAM reads its config at startup, so this rolls the pod. Manual by default:
# a stray save should not cost two minutes.
local_resource(
    'am-config',
    cmd = fo + ' restart am',
    deps = ['platform/am/config'],
    labels = ['slow'],
    trigger_mode = TRIGGER_MODE_MANUAL,
    auto_init = False,
)

local_resource(
    'status',
    cmd = fo + ' status',
    labels = ['info'],
    trigger_mode = TRIGGER_MODE_MANUAL,
    auto_init = False,
)
