import { shallowMount, createLocalVue } from '@vue/test-utils';
import makeStore from '../makeStore';
import TopicsContentPage from '../../src/views/TopicsContentPage';

jest.mock('kolibri.urls');

jest.mock('plugin_data', () => {
  return {
    __esModule: true,
    default: {
      channels: [],
    },
  };
});

const localVue = createLocalVue();

const store = makeStore();
store.state.core = {
  blockDoubleClicks: true,
  loading: false,
  logging: {
    summary: {
      progress: 0,
    },
  },
};
store.state.topicsTree = {
  content: {
    coach_content: 0,
  },
};

store.getters = {
  isAdmin() {
    return false;
  },
};

function makeWrapper({ propsData } = {}) {
  return shallowMount(TopicsContentPage, {
    propsData,
    store,
    localVue,
    stubs: {
      LearningActivityBar: {
        name: 'LearningActivityBar',
        propsData: {
          resourceTitle: 'Test Title',
        },
        template: '<div></div>',
      },
      ContentPage: {
        name: 'ContentPage',
        template: '<div><slot></slot></div>',
      },
    },
  });
}

describe('TopicsContentPage', () => {
  const wrapper = makeWrapper({
    propsData: {
      content: { id: 'test' },
    },
  });
  it('smoke test', () => {
    expect(wrapper.exists()).toBe(true);
  });

  it('shows the Learning Activity Bar', () => {
    expect(wrapper.find('[data-test="learningActivityBar"]').exists()).toBeTruthy();
  });

  it('shows the Content Page', () => {
    expect(wrapper.find('[data-test="contentPage"]').exists()).toBeTruthy();
  });
});
