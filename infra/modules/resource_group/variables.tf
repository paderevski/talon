variable "group_name" {
  type        = string
  description = "Resource group name."
}

variable "project_tag_value" {
  type        = string
  description = "Project tag filter value."
}

variable "environment_tag_value" {
  type        = string
  description = "Environment tag filter value."
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to all resources."
  default     = {}
}
