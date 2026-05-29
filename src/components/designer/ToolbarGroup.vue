<template>
  <div class="vue-canvas-sheet-tool-group-wrapper" :class="{ 'is-compact': compact }" :style="groupStyle">
    <template v-if="!compact">
      <div class="group-content">
        <slot></slot>
      </div>
    </template>
    <template v-else>
      <div class="compact-trigger" @click.stop="togglePopover">
        <div class="trigger-icon">
          <SvgIcon v-if="icon" :name="icon" />
        </div>
        <div class="trigger-label">
          <span class="trigger-caret"></span>
        </div>
      </div>
      <div class="popover-content compact-popover" :style="{ width: popoverWidth + 'px' }" v-if="showPopover" @click.stop>
        <div class="compact-popover-content">
          <div class="popover-header">{{ label }}</div>
          <div class="group-content">
            <slot></slot>
          </div>
        </div>
      </div>
    </template>
    <div class="group-separator"></div>
  </div>
</template>
<script>
  import SvgIcon from './icons/SvgIcon.vue';

  export default {
    name: 'ToolbarGroup',
    components: { SvgIcon },
    props: {
      label: String,
      icon: String,
      compact: Boolean,
      popoverWidth: {
        type: Number,
        default: 200
      }
    },
    data() {
      return {
        showPopover: false
      }
    },
    mounted() {
      document.addEventListener('click', this.closePopover);
      document.addEventListener('close-all-popovers', this.handleCloseAll);
    },
    beforeUnmount() {
      document.removeEventListener('click', this.closePopover);
      document.removeEventListener('close-all-popovers', this.handleCloseAll);
    },
    methods: {
      closePopover() {
        this.showPopover = false;
      },
      togglePopover() {
        if (!this.showPopover) {
          document.dispatchEvent(new CustomEvent('close-all-popovers', { detail: this }));
        }
        this.showPopover = !this.showPopover;
      },
      handleCloseAll(e) {
        if (e.detail !== this && e.detail !== this.$parent) {
          this.showPopover = false;
        }
      }
    },
    computed: {
      groupStyle() {
        return {};
      }
    }
  }
</script>
<style scoped lang="scss">
  .vue-canvas-sheet-tool-group-wrapper {
    display: flex;
    flex-direction: row;
    align-items: center;
    height: 100%;
    padding: 0 8px;
    position: relative;
    transition: all 0.2s ease;
    user-select: none;
    min-height: auto;
  }

  .group-content {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    justify-content: center;
    gap: 2px;
    height: 100%;
  }

  .group-separator {
    position: absolute;
    right: 0;
    top: 8px;
    bottom: 8px;
    width: 1px;
    background: #e1e1e1;
  }

  .compact-trigger {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    height: 100%;
    cursor: pointer;
    padding: 0 8px;
    border-radius: 4px;
    transition: background-color 0.1s;
    min-width: unset;
    gap: 4px;

    &:hover {
      background: #e6e6e6;

      .trigger-label {
        color: #000;
      }

      .trigger-icon {
        color: #000;
      }
    }
  }

  .trigger-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    color: #444;
    width: auto;
    flex: none;
  }

  .trigger-label {
    font-size: 13px;
    color: #444;
    display: flex;
    align-items: center;
    gap: 2px;
    margin: 0;
    line-height: 1;
    font-family: inherit;
  }

  .trigger-caret {
    width: 0;
    height: 0;
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-top: 5px solid currentColor;
  }

  .compact-popover-content {
    .popover-header {
      font-weight: 600;
      font-size: 13px;
      color: #333;
      padding-bottom: 8px;
      margin-bottom: 8px;
      border-bottom: 1px solid #e1e1e1;
      background: #f3f3f3;
      padding: 8px 12px;
      margin: -12px -12px 8px -12px;
    }

    .group-content {
      justify-content: flex-start;
      gap: 4px;
      flex-wrap: wrap;
    }
  }

  .compact-popover {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-top: 8px;
    background: #fff;
    border: 1px solid #e4e7ed;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 2000;
    padding: 12px;
  }
</style>
