// GENERATED — do not edit.
//
// Written by `fo build` from platform/idm/conf/managed.json, which
// `fo config export idm` puts there. Re-run either after changing a managed
// object, and commit the result: it is the only reason a fresh clone
// type-checks without a cluster.

/**
 * A reference to another managed object. PingIDM returns these expanded only
 * when the query asks for it, so everything but `_ref` is optional.
 */
export type ManagedRelationship = {
  _ref: string;
  _refResourceCollection?: string | null;
  _refResourceId?: string | null;
  _refProperties?: Record<string, unknown> | null;
};

/** PingIDM `managed/user` (User). */
export interface ManagedUser {
  /** User ID */
  _id?: string | null;
  /** Password */
  password?: string | null;
  /** Password Last Changed Time */
  passwordLastChangedTime?: string | null;
  /** Password Expiration Time */
  passwordExpirationTime?: string | null;
  /** Common Name */
  cn?: string | null;
  /** KBA Info */
  kbaInfo?: Array<{
    /** Answer */
    answer?: string | null;
    /** Custom question */
    customQuestion?: string | null;
    /** Question ID */
    questionId?: string | null;
  }> | null;
  /** Preferences */
  preferences?: {
    /** Send me news and updates */
    updates?: boolean | null;
    /** Send me special offers and services */
    marketing?: boolean | null;
  } | null;
  /** Email Address */
  mail: string;
  /** Last Name */
  sn: string;
  /** Profile Image */
  profileImage?: string | null;
  /** Push Device Profiles */
  pushDeviceProfiles?: string[] | null;
  /** Description */
  description?: string | null;
  /** Device Print Profiles — Device Print Profiles Information */
  devicePrintProfiles?: string[] | null;
  /** Device Profiles */
  deviceProfiles?: string[] | null;
  /** First Name */
  givenName: string;
  /** City */
  city?: string | null;
  /** Country */
  country?: string | null;
  /** Postal Code */
  postalCode?: string | null;
  /** Status */
  accountStatus?: string | null;
  /** Provisioning Roles */
  roles?: ManagedRelationship[] | null;
  /** Assignments */
  assignments?: ManagedRelationship[] | null;
  /** Group — Groups */
  groups?: ManagedRelationship[] | null;
  /** Applications */
  applications?: ManagedRelationship[] | null;
  /** Authorization Roles */
  authzRoles?: ManagedRelationship[] | null;
  /** Direct Reports */
  reports?: ManagedRelationship[] | null;
  /** Effective Roles */
  effectiveRoles?: Array<Record<string, unknown>> | null;
  /** Effective Assignments */
  effectiveAssignments?: Array<Record<string, unknown>> | null;
  /** Effective Groups */
  effectiveGroups?: Array<Record<string, unknown>> | null;
  /** Effective Applications */
  effectiveApplications?: Array<Record<string, unknown>> | null;
  /** Telephone Number */
  telephoneNumber?: string | null;
  /** State/Province */
  stateProvince?: string | null;
  /** Assigned Dashboard — List of items to click on for this user */
  assignedDashboard?: string[] | null;
  /** Address 1 */
  postalAddress?: string | null;
  /** Username */
  userName: string;
  /** Web AuthN Device Profiles */
  webauthnDeviceProfiles?: string[] | null;
  /** Manager */
  manager?: ManagedRelationship | null;
  /** Last Sync timestamp */
  lastSync?: {
    /** Effective Assignments */
    effectiveAssignments?: Array<Record<string, unknown>> | null;
    /** Timestamp */
    timestamp?: string | null;
  } | null;
  /** Consented Mappings */
  consentedMappings?: Array<Array<{
    /** Mapping */
    mapping: string;
    /** Consent Date */
    consentDate: string;
  }>> | null;
  /** User Alias Names List — List of identity aliases used primarily to record social IdP subjects for this user */
  aliasList?: string[] | null;
  /** Organizations I Own */
  ownerOfOrg?: ManagedRelationship[] | null;
  /** Organizations I Administer */
  adminOfOrg?: ManagedRelationship[] | null;
  /** Organizations to which I Belong */
  memberOfOrg?: ManagedRelationship[] | null;
  /** MemberOfOrgIDs */
  memberOfOrgIDs?: string[] | null;
  /** Oath Device Profiles */
  oathDeviceProfiles?: string[] | null;
  /** Active Date */
  activeDate?: string | null;
  /** Inactive Date */
  inactiveDate?: string | null;
  /** Applications I Own */
  ownerOfApp?: ManagedRelationship[] | null;
}

/** PingIDM `managed/role` (Role). */
export interface ManagedRole {
  /** Name — Role ID */
  _id?: string | null;
  /** Name — The role name, used for display purposes. */
  name: string;
  /** Description — The role description, used for display purposes. */
  description?: string | null;
  /** Role Members */
  members?: ManagedRelationship[] | null;
  /** Managed Assignments */
  assignments?: ManagedRelationship[] | null;
  /** Applications — Role Applications */
  applications?: ManagedRelationship[] | null;
  /** Condition — A conditional filter for this role */
  condition?: string | null;
  /** Temporal Constraints — An array of temporal constraints for a role */
  temporalConstraints?: Array<{
    /** Duration */
    duration: string;
  }> | null;
}

/** PingIDM `managed/assignment` (Assignment). */
export interface ManagedAssignment {
  /** Name — The assignment ID */
  _id?: string | null;
  /** Name — The assignment name, used for display purposes. */
  name: string;
  /** Description — The assignment description, used for display purposes. */
  description: string;
  /** Mapping — The name of the mapping this assignment applies to */
  mapping: string;
  /** Assignment Attributes — The attributes operated on by this assignment. */
  attributes?: Array<{
    /** Assignment operation */
    assignmentOperation?: string | null;
    /** Unassignment operation */
    unassignmentOperation?: string | null;
    /** Name */
    name?: string | null;
    /** Value */
    value?: string | null;
  }> | null;
  /** Type — The type of object this assignment represents */
  type?: string | null;
  /** Link Qualifiers — Conditional link qualifiers to restrict this assignment to. */
  linkQualifiers?: string[] | null;
  /** Managed Roles */
  roles?: ManagedRelationship[] | null;
  /** Assignment Members */
  members?: ManagedRelationship[] | null;
  /** Condition — A conditional filter for this assignment */
  condition?: string | null;
  /** Weight — The weight of the assignment. */
  weight?: number | null;
}

/** PingIDM `managed/organization` (Organization). */
export interface ManagedOrganization {
  /** Name */
  name: string;
  /** Description */
  description?: string | null;
  /** Owner */
  owners?: ManagedRelationship[] | null;
  /** Administrators */
  admins?: ManagedRelationship[] | null;
  /** Members */
  members?: ManagedRelationship[] | null;
  /** Parent Organization */
  parent?: ManagedRelationship | null;
  /** Child Organizations */
  children?: ManagedRelationship[] | null;
  /** Admin user ids */
  adminIDs?: string[] | null;
  /** Owner user ids */
  ownerIDs?: string[] | null;
  /** user ids of parent admins */
  parentAdminIDs?: string[] | null;
  /** user ids of parent owners */
  parentOwnerIDs?: string[] | null;
  /** parent org ids */
  parentIDs?: string[] | null;
}

/** PingIDM `managed/group` (Group). */
export interface ManagedGroup {
  /** Group ID */
  _id?: string | null;
  /** Name — Group Name */
  name: string;
  /** Description — Group Description */
  description?: string | null;
  /** Condition — A filter for conditionally assigned members */
  condition?: string | null;
  /** Members — Group Members */
  members?: ManagedRelationship[] | null;
  /** Agent Privileges — AI Agent Privileges assigned to this group */
  aiagentprivileges?: ManagedRelationship[] | null;
}

/** PingIDM `managed/application` (Application). */
export interface ManagedApplication {
  /** Application ID */
  _id?: string | null;
  /** Name — Application name */
  name: string;
  /** Description — Application Description */
  description?: string | null;
  /** Owners — Application Owners */
  owners?: ManagedRelationship[] | null;
  /** Url */
  url?: string | null;
  /** Icon */
  icon?: string | null;
  /** Roles — Roles granting users the application */
  roles?: ManagedRelationship[] | null;
  /** Members — Members directly granted an application */
  members?: ManagedRelationship[] | null;
  /** Sync Mapping Names — Names of the sync mappings used by an application with provisioning configured. */
  mappingNames?: string[] | null;
  /** Connector ID — Id of the connector associated with the application */
  connectorId?: string | null;
  /** Template Name — Name of the template the application was created from */
  templateName?: string | null;
  /** Template Version — The template version */
  templateVersion?: string | null;
  /** SSO Entity Id */
  ssoEntities?: {
    idpPrivateId?: string | null;
    idpLocation?: string | null;
    spPrivate?: string | null;
    spLocation?: string | null;
    spPrivateId?: string | null;
    domain?: string | null;
    idpLoginUrl?: string | null;
    key?: string | null;
    oidcId?: string | null;
    pfSigningCertId?: string | null;
    pfIdpAdapterId?: string | null;
    pfApcId?: string | null;
    pfPolicyId?: string | null;
    pfSpConnectionId?: string | null;
    federatedDomain?: string | null;
  } | null;
  /** AI Agent Privileges — AI Agent Privileges targeting this application */
  aiagentprivileges?: ManagedRelationship[] | null;
  /** UI Config */
  uiConfig?: Record<string, unknown> | null;
  /** Authoritative — Is this an authoritative application */
  authoritative?: boolean | null;
}

/** PingIDM `managed/aiagent` (AI Agent). */
export interface ManagedAiagent {
  /** Agent ID */
  _id?: string | null;
  /** Agent Name */
  name: string;
  /** Description — Agent Description */
  description?: string | null;
  /** OAuth2 Client ID — ID of the agent's OAuth2 client */
  oauth2ClientId: string;
  /** Agent Owners */
  owners?: ManagedRelationship[] | null;
  /** Privileges — Agent Privileges */
  privileges?: ManagedRelationship[] | null;
  /** Custom Attributes — JSON object for arbitrary attributes */
  customAttributes?: Record<string, unknown> | null;
}

/** PingIDM `managed/aiagentprivilege` (AI Agent Privilege). */
export interface ManagedAiagentprivilege {
  /** Agent Privilege ID */
  _id?: string | null;
  /** Description — Privilege Description */
  description?: string | null;
  /** Agent */
  agent: ManagedRelationship;
  /** Agent ID — ID of the associated AI Agent */
  agentID?: string | null;
  /** Agent OAuth2 Client ID — OAuth2 Client ID of the associated AI Agent */
  agentOAuth2ClientId?: string | null;
  /** Resource — The resource this privilege applies to */
  resource?: ManagedRelationship | null;
  /** Resource Data — Resource identifiers for querying privileges by application */
  resourceData?: Record<string, unknown> | null;
  /** Subjects — The subjects participating in this privilege, on whose behalf the agent can operate */
  subjects?: ManagedRelationship[] | null;
  /** Subject Groups — Group of subjects participating in this privilege, on whose behalf the agent can operate */
  subjectGroups?: ManagedRelationship[] | null;
  /** Subject IDs — IDs of the subjects */
  subjectIDs?: string[] | null;
  /** Permissions — Permission grants for this privilege */
  permissions?: Array<{
    /** Permission Type — Type of permission */
    type: string;
    /** Values — Permission values */
    values: string[];
  }> | null;
}

declare global {
  /** Every managed object this deployment defines, keyed by collection path. */
  interface ManagedObjects {
    "managed/user": ManagedUser;
    "managed/role": ManagedRole;
    "managed/assignment": ManagedAssignment;
    "managed/organization": ManagedOrganization;
    "managed/group": ManagedGroup;
    "managed/application": ManagedApplication;
    "managed/aiagent": ManagedAiagent;
    "managed/aiagentprivilege": ManagedAiagentprivilege;
  }
}
