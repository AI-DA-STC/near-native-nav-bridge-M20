from glob import glob

from setuptools import setup

package_name = 'm20_rmf'

setup(
    name=package_name,
    version='0.1.0',
    packages=[package_name],
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        ('share/' + package_name + '/launch', glob('launch/*.py')),
        ('share/' + package_name + '/sites', glob('sites/*.yaml')),
        ('share/' + package_name + '/missions', glob('missions/*.yaml')),
        ('share/' + package_name + '/rviz', glob('rviz/*.rviz')),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='darkuantum',
    maintainer_email='darkuantum.coding@gmail.com',
    description='Open-RMF fleet adapter and mission primitives for DeepRobotics M20',
    license='Apache-2.0',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'fleet_adapter = m20_rmf.fleet_adapter:main',
            'monitor = m20_rmf.monitor:main',
            'mock_robot = m20_rmf.mock_robot:main',
            'mission = m20_rmf.mission:main',
            'm20 = m20_rmf.cli:main',
        ],
    },
)
